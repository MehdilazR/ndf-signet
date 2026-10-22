/*
 * NDF Express — version signet (bookmarklet).
 * S'ouvre par-dessus la page Boond (ui.boondmanager.com), dans ta session,
 * et fait la même chose que l'app Android : tickets → OCR Boond (Mindee) →
 * règles du lot → récapitulatif → lignes ajoutées à la note du mois.
 */
(function () {
  'use strict';

  var BASE = 'https://ui.boondmanager.com';
  if (location.origin !== BASE) {
    location.href = BASE + '/dashboard';
    return;
  }
  if (window.__ndfExpress) { window.__ndfExpress.show(); return; }

  // ------------------------------------------------------------------ outils

  function safeJSON(text) { try { return JSON.parse(text); } catch (e) { return null; } }
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function round2(x) { return Math.round(x * 100) / 100; }
  function euro(x) {
    if (x == null || isNaN(x)) return '—';
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(x);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function termKey(t) { return t.y + '-' + pad(t.m); }
  function addMonths(t, d) { var m = t.m - 1 + d; return { y: t.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 + 1 }; }
  var MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  function monthLabel(t) { return MONTHS[t.m - 1] + ' ' + t.y; }
  function frDate(iso) { if (!iso) return '—'; var p = iso.slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso; }
  function num(v) {
    if (v == null || v === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return isFinite(n) ? n : null;
  }
  function normalize(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function str(o, k) { if (!o || o[k] == null) return null; var s = String(o[k]).trim(); return s && s !== 'null' ? s : null; }

  // ------------------------------------------------------------------ préférences

  var PREF_KEY = 'ndf-express';
  var prefs = Object.assign({ cap: true, capAmount: 15, simulation: true, type: null, imputation: null },
    safeJSON(localStorage.getItem(PREF_KEY)) || {});
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {} }

  // ------------------------------------------------------------------ API Boond (dans ta session)

  var logLines = [];
  function log(line) {
    var d = new Date();
    logLines.push(pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '  ' + line);
    if (logLines.length > 200) logLines.shift();
  }

  function csrfToken() {
    var s = safeJSON(localStorage.getItem('ember_simple_auth-session')) || {};
    return s.authenticated && s.authenticated.meta && s.authenticated.meta.csrf;
  }
  function frontVersion() {
    try {
      var meta = document.querySelector('meta[name$="/config/environment"]');
      return JSON.parse(decodeURIComponent(meta.content)).version || '';
    } catch (e) { return ''; }
  }

  function ApiError(status, message) { var e = new Error(message); e.status = status; return e; }

  function describeError(status, text) {
    var detail = null;
    var first = ((safeJSON(text) || {}).errors || [])[0];
    if (first) {
      if (first.detail && first.detail.indexOf('HTTP ') !== 0) detail = first.detail;
      else if (first.title && first.title !== String(status)) detail = first.title;
    }
    var hint = status === 403 ? 'Boond refuse cette action pour ton compte'
      : status === 404 ? 'Élément introuvable dans Boond'
      : status === 422 ? 'Données refusées par Boond'
      : 'Erreur Boond ' + status;
    return detail ? hint + ' : ' + detail : hint;
  }

  async function api(method, path, options) {
    options = options || {};
    var csrf = csrfToken();
    // Sans jeton, on n'appelle pas Boond (un appel incomplet ferme la session).
    if (!csrf) throw ApiError(401, 'Tu n\'es pas connecté à Boond : connecte-toi, puis touche à nouveau le signet.');
    var headers = {
      'x-csrf-boondmanager': csrf,
      'x-front-boondmanager': 'ember',
      'x-front-version': frontVersion(),
      'Accept': 'application/vnd.api+json'
    };
    var init = { method: method, credentials: 'include', headers: headers };
    if (options.json) { init.body = JSON.stringify(options.json); headers['Content-Type'] = 'application/vnd.api+json'; }
    if (options.form) {
      init.body = options.form;
      headers.Accept = 'application/json';
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers['Cache-Control'] = 'no-cache';
    }
    var response;
    try { response = await fetch('/api' + path, init); }
    catch (e) { log(method + ' ' + path.split('?')[0] + ' → erreur réseau'); throw ApiError(-1, 'Connexion à Boond impossible.'); }
    var text = await response.text();
    log(method + ' ' + path.split('?')[0] + ' → ' + response.status);
    if (response.status === 401) throw ApiError(401, 'Ta session Boond a expiré : recharge la page, reconnecte-toi, puis touche à nouveau le signet.');
    if (!response.ok) throw ApiError(response.status, describeError(response.status, text));
    return text ? JSON.parse(text) : {};
  }

  // ------------------------------------------------------------------ logique Boond

  async function currentUser() {
    var json = await api('GET', '/application/current-user');
    var data = json.data || {};
    var a = data.attributes || {};
    var id = data.id;
    var linked = data.relationships && data.relationships.resource && data.relationships.resource.data;
    if (data.type !== 'resource' && linked && linked.id) id = linked.id;
    var name = [str(a, 'firstName'), str(a, 'lastName')].filter(Boolean).join(' ') || ('Ressource #' + id);
    return { id: String(id), name: name };
  }

  async function findReportId(resourceId, term) {
    var json = await api('GET', '/resources/' + resourceId + '/expensesreports');
    var key = termKey(term);
    var list = json.data || [];
    for (var i = 0; i < list.length; i++) {
      var t = (list[i].attributes || {}).term || '';
      if (t.indexOf(key) === 0) return String(list[i].id);
    }
    return null;
  }

  function loadReport(id) { return api('GET', '/expensesreports/' + id); }
  function linesOf(report) { return (report && report.data && report.data.attributes && report.data.attributes.actualExpenses) || []; }
  function reportRef(report) {
    var d = report && report.data; if (!d) return null;
    return str(d.attributes, 'reference') || ('EXP' + d.id);
  }
  function includedIndex(report) {
    var map = {};
    ((report && report.included) || []).forEach(function (it) { map[it.type + ':' + it.id] = it; });
    return map;
  }
  function companyName(inc, projectId) {
    var proj = inc['project:' + projectId];
    var rel = proj && proj.relationships && proj.relationships.company && proj.relationships.company.data;
    var company = rel && inc['company:' + rel.id];
    return company ? str(company.attributes, 'name') : null;
  }
  function refId(line, field) {
    var v = line[field];
    if (v == null) return '';
    var id = typeof v === 'object' ? v.id : v;
    id = id == null ? '' : String(id);
    return id === '0' || id === 'null' ? '' : id;
  }
  function describe(line, field, inc, prefix, id) {
    var emb = line[field] && typeof line[field] === 'object' ? line[field] : null;
    var cands = [emb, emb && emb.attributes, (inc[field + ':' + id] || {}).attributes];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i]; if (!c) continue;
      var v = str(c, 'reference') || str(c, 'title') || str(c, 'name');
      if (v) return v;
    }
    return prefix + id;
  }

  function imputationsOf(reports) {
    var found = {}; var order = [];
    reports.forEach(function (report) {
      var inc = includedIndex(report);
      linesOf(report).forEach(function (line) {
        if (line.isKilometricExpense) return;
        var p = refId(line, 'project'), d = refId(line, 'delivery'), b = refId(line, 'batch');
        var key = p + '|' + d + '|' + b;
        var date = String(line.startDate || '').slice(0, 10);
        if (found[key]) { if (date > found[key].lastDate) found[key].lastDate = date; return; }
        var label;
        if (!p) label = 'Interne (sans projet)';
        else {
          var parts = [describe(line, 'project', inc, 'PRJ', p)];
          if (d) parts.push(describe(line, 'delivery', inc, 'MIS', d));
          var company = companyName(inc, p);
          if (company && parts[0].indexOf(company) < 0) parts.push(company);
          label = parts.join(' · ');
        }
        found[key] = { key: key, label: label, template: line, lastDate: date };
        order.push(key);
      });
    });
    return order.map(function (k) { return found[k]; });
  }

  function collectArrays(node, name, out) {
    out = out || [];
    if (Array.isArray(node)) node.forEach(function (n) { collectArrays(n, name, out); });
    else if (node && typeof node === 'object') {
      Object.keys(node).forEach(function (k) {
        if (k === name && Array.isArray(node[k])) out.push(node[k]); else collectArrays(node[k], name, out);
      });
    }
    return out;
  }

  function expenseTypesOf(reports) {
    var found = {}; var order = [];
    function add(et) {
      if (!et) return;
      var ref = et.reference == null ? '' : String(et.reference);
      if (!ref || ref === '0' || ref === 'null') return;
      var name = str(et, 'name'); if (name === ref) name = null;
      var cur = found[ref];
      if (!cur) { found[ref] = { reference: ref, label: name || 'Type n°' + ref, json: et }; order.push(ref); }
      else if (cur.label.indexOf('Type n°') === 0 && name) { found[ref] = { reference: ref, label: name, json: et }; }
    }
    reports.forEach(function (report) {
      collectArrays(report, 'expenseTypes').forEach(function (arr) { arr.forEach(add); });
      linesOf(report).forEach(function (l) { add(l.expenseType); });
    });
    return order.map(function (k) { return found[k]; });
  }

  function findObject(node, name) {
    if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) { var r = findObject(node[i], name); if (r) return r; } }
    else if (node && typeof node === 'object') {
      if (node[name] && typeof node[name] === 'object' && !Array.isArray(node[name])) return node[name];
      var keys = Object.keys(node);
      for (var j = 0; j < keys.length; j++) { var r2 = findObject(node[keys[j]], name); if (r2) return r2; }
    }
    return null;
  }

  function parseUpload(json) {
    var data = Array.isArray(json.data) ? json.data[0] : json.data;
    var docId = data && data.id ? String(data.id) : '';
    var parsedRel = data && data.relationships && data.relationships.parsedDocument && data.relationships.parsedDocument.data;
    var parsing = null;
    (json.included || []).forEach(function (it) {
      if (String(it.type).toLowerCase().indexOf('parsed') >= 0 && (!parsedRel || String(it.id) === String(parsedRel.id))) {
        parsing = it.attributes && it.attributes.parsingData;
      }
    });
    if (!parsing) parsing = findObject(json, 'parsingData');
    return { documentId: docId, parsing: parsing };
  }

  function isDuplicate(report, date, amount) {
    return linesOf(report).some(function (l) {
      var a = num(l.amountIncludingTax);
      return String(l.startDate || '').slice(0, 10) === date && a != null && Math.abs(a - amount) < 0.005;
    });
  }

  function buildLine(imputation, type, item, defaultTax) {
    var line = JSON.parse(JSON.stringify(imputation.template));
    delete line.id;
    Object.keys(line).forEach(function (k) { if (k.indexOf('guest') === 0 && Array.isArray(line[k])) line[k] = []; });
    if ('reinvoiced' in line) line.reinvoiced = false;
    if ('isKilometricExpense' in line) line.isKilometricExpense = false;
    if ('numberOfKilometers' in line) line.numberOfKilometers = 0;
    if ('title' in line) line.title = '';
    line.startDate = item.date;
    line.amountIncludingTax = item.finalAmount;
    line.tax = item.taxRate != null ? item.taxRate : defaultTax;
    ['originalAmountIncludingTax', 'originalAmount'].forEach(function (k) { if (k in line) line[k] = item.finalAmount; });
    var et = JSON.parse(JSON.stringify(imputation.template.expenseType || {}));
    et.reference = typeof et.reference === 'number' ? (parseInt(type.reference, 10) || type.reference) : type.reference;
    ['taxRate', 'name', 'guest', 'mealDeduction'].forEach(function (k) { if (k in type.json) et[k] = type.json[k]; });
    line.expenseType = et;
    line.file = line.file && typeof line.file === 'object' ? { id: item.documentId } : item.documentId;
    return line;
  }

  // ------------------------------------------------------------------ images

  async function prepareFile(file) {
    var name = file.name || 'justificatif';
    if (file.type === 'application/pdf') return { blob: file, name: /\.pdf$/i.test(name) ? name : name + '.pdf' };
    try {
      var url = URL.createObjectURL(file);
      var img = await new Promise(function (resolve, reject) {
        var i = new Image(); i.onload = function () { resolve(i); }; i.onerror = reject; i.src = url;
      });
      var max = 2200, w = img.naturalWidth, h = img.naturalHeight;
      var scale = Math.min(1, max / Math.max(w, h));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.88); });
      if (!blob) throw new Error('compression');
      return { blob: blob, name: name.replace(/\.[^.]+$/, '') + '.jpg' };
    } catch (e) {
      return { blob: file, name: name }; // format non décodable ici : envoi tel quel
    }
  }

  // ------------------------------------------------------------------ état

  var now = new Date();
  var S = {
    screen: 'home', busy: false, error: null,
    term: { y: now.getFullYear(), m: now.getMonth() + 1 },
    user: null, reportId: null, report: null, reportRefLabel: null,
    imputations: [], types: [], items: [], processing: false,
    result: null, lastUpload: null, lastPayload: null, editing: null, showDiag: false
  };
  var nextId = 1;
  var stopRequested = false;

  function selectedImputation() { return S.imputations.filter(function (i) { return i.key === prefs.imputation; })[0] || null; }
  function selectedType() { return S.types.filter(function (t) { return t.reference === prefs.type; })[0] || null; }
  function sendable() {
    return S.items.filter(function (it) {
      return it.included && (it.status === 'ready' || it.status === 'duplicate') && it.documentId && it.date && it.finalAmount != null;
    });
  }

  function evaluate(item) {
    if (['pending', 'uploading', 'error'].indexOf(item.status) >= 0) return item;
    var date = item.date, ticket = item.ticketAmount;
    if (!date || ticket == null || ticket <= 0) {
      return Object.assign(item, { status: 'needs', finalAmount: null, capped: false, included: false, message: 'Date ou montant non lu : touche pour compléter' });
    }
    var capped = prefs.cap && ticket > prefs.capAmount;
    var final = capped ? prefs.capAmount : ticket;
    if (date.indexOf(termKey(S.term)) !== 0) {
      return Object.assign(item, { status: 'outofmonth', finalAmount: final, capped: capped, included: false, message: 'Daté du ' + frDate(date) + ' : hors ' + monthLabel(S.term) + ', écarté' });
    }
    if (isDuplicate(S.report, date, final)) {
      return Object.assign(item, { status: 'duplicate', finalAmount: final, capped: capped, included: false, message: 'Une ligne du ' + frDate(date) + ' à ' + euro(final) + ' existe déjà' });
    }
    return Object.assign(item, { status: 'ready', finalAmount: final, capped: capped, included: true, message: capped ? 'Plafonné : ticket de ' + euro(ticket) : null });
  }

  // ------------------------------------------------------------------ actions

  async function refresh() {
    S.busy = true; S.error = null; render();
    try {
      if (!S.user) S.user = await currentUser();
      var id = await findReportId(S.user.id, S.term);
      var current = id ? await loadReport(id) : null;
      var previous = null;
      try { var pid = await findReportId(S.user.id, addMonths(S.term, -1)); previous = pid ? await loadReport(pid) : null; }
      catch (e) { if (e.status === 401) throw e; }
      var reports = [current, previous].filter(Boolean);
      S.reportId = id; S.report = current; S.reportRefLabel = current ? reportRef(current) : null;
      S.imputations = imputationsOf(reports);
      S.types = expenseTypesOf(reports);
      // Par défaut : le projet de la ligne la plus récente (seul un choix manuel est mémorisé).
      if (!selectedImputation()) {
        var withProject = S.imputations.filter(function (i) { return i.key.charAt(0) !== '|'; })
          .sort(function (a, b) { return a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0; })[0];
        prefs.imputation = (withProject || S.imputations[0] || {}).key || null;
      }
      if (!selectedType()) {
        var t = S.types.filter(function (x) { return normalize(x.label) === 'dejeuner ss tva'; })[0]
          || S.types.filter(function (x) { return normalize(x.label).indexOf('dejeuner') >= 0; })[0] || S.types[0];
        prefs.type = t ? t.reference : null;
      }
      S.items.forEach(evaluate);
    } catch (e) {
      if (e.status === 401) { waitForLogin(); return; }
      S.error = e.message;
    }
    S.busy = false; render();
  }

  function addFiles(fileList) {
    var known = S.items.map(function (i) { return i.file.name + ':' + i.file.size; });
    Array.prototype.forEach.call(fileList, function (f) {
      if (known.indexOf(f.name + ':' + f.size) >= 0) return;
      S.items.push({ id: nextId++, file: f, thumb: f.type === 'application/pdf' ? null : URL.createObjectURL(f), status: 'pending', included: true });
    });
    render();
  }

  async function start(onlyErrors) {
    if (!onlyErrors) {
      var problem = !S.reportId ? 'Aucune note de frais pour ' + monthLabel(S.term) + '. Ouvre ce mois une fois dans Boond pour la créer, puis actualise.'
        : !selectedImputation() ? 'Choisis un projet. S\'il n\'apparaît pas, saisis une première ligne sur ce projet dans Boond : NDF Express apprendra son format.'
        : !selectedType() ? 'Choisis le type de frais.'
        : !S.items.length ? 'Ajoute au moins un justificatif.' : null;
      if (problem) { S.error = problem; render(); return; }
    }
    var todo = S.items.filter(function (i) { return onlyErrors ? i.status === 'error' : (i.status === 'pending' || i.status === 'error'); });
    S.screen = 'processing'; S.processing = true; stopRequested = false; S.error = null; render();
    for (var k = 0; k < todo.length; k++) {
      if (stopRequested) break;
      var item = todo[k];
      item.status = 'uploading'; item.message = null; render();
      try {
        var prepared = await prepareFile(item.file);
        var form = new FormData();
        form.append('parentType', 'expensesReport');
        form.append('parentId', S.reportId);
        form.append('expenseId', '0');
        form.append('parsing', 'true');
        form.append('file', prepared.blob, prepared.name);
        var json = await api('POST', '/documents', { form: form });
        S.lastUpload = JSON.stringify(json, null, 2);
        var up = parseUpload(json);
        if (!up.documentId) { Object.assign(item, { status: 'error', message: 'Boond n\'a pas renvoyé de justificatif' }); continue; }
        var p = up.parsing || {};
        var d = typeof p.startDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p.startDate) ? p.startDate.slice(0, 10) : null;
        var amount = num(p.amountIncludingTax);
        if (!up.parsing) log('Aucune donnée OCR pour ' + item.file.name);
        Object.assign(item, { status: 'ready', documentId: up.documentId, date: d, ticketAmount: amount != null && amount > 0 ? round2(amount) : null, taxRate: num(p.tax) });
        evaluate(item);
      } catch (e) {
        if (e.status === 401) { item.status = 'pending'; S.processing = false; S.screen = 'review'; S.error = e.message; render(); return; }
        Object.assign(item, { status: 'error', message: e.message });
      }
      render();
    }
    S.items.forEach(function (i) { if (i.status === 'uploading') i.status = 'pending'; });
    S.processing = false; S.screen = 'review'; render();
  }

  async function submit() {
    var imp = selectedImputation(), type = selectedType(), toSend = sendable();
    if (!imp || !type || !toSend.length) { S.error = 'Aucune ligne à envoyer.'; render(); return; }
    S.busy = true; S.error = null; render();
    try {
      var fresh = await loadReport(S.reportId); // relecture : on ne perd aucune ligne ajoutée entre-temps
      S.report = fresh;
      var all = linesOf(fresh).slice();
      var defaultTax = num(type.json.taxRate) || 0;
      toSend.forEach(function (it) { all.push(buildLine(imp, type, it, defaultTax)); });
      var body = { data: { id: S.reportId, type: 'expensesreport', attributes: { actualExpenses: all } } };
      if (!prefs.simulation) await api('PUT', '/expensesreports/' + S.reportId, { json: body });
      S.lastPayload = JSON.stringify(body, null, 2);
      var total = toSend.reduce(function (s, i) { return s + i.finalAmount; }, 0);
      S.result = prefs.simulation
        ? 'Simulation : ' + toSend.length + ' ligne(s) prête(s) pour ' + euro(total) + '. Rien n\'a été enregistré dans la note ; les justificatifs, eux, ont été joints à la note pour être lus.'
        : toSend.length + ' ligne(s) ajoutée(s) à ' + (S.reportRefLabel || 'la note') + ' pour ' + euro(total) + '.';
      S.screen = 'done';
    } catch (e) { S.error = 'Envoi refusé. ' + e.message; }
    S.busy = false; render();
  }

  function newBatch() {
    S.items.forEach(function (i) { if (i.thumb) URL.revokeObjectURL(i.thumb); });
    S.items = []; S.result = null; S.screen = 'home';
    refresh();
  }

  // ------------------------------------------------------------------ interface

  var FULL = 'position:fixed;inset:0;z-index:2147483647;';
  var waitTimer = null;
  var reloadOnClose = false;
  var host = document.createElement('div');
  host.id = 'ndf-express-host';
  host.style.cssText = FULL;

  function loggedIn() { return !!csrfToken() && location.pathname.indexOf('/login') !== 0; }

  // Pas (ou plus) connecté : la page de connexion Boond s'affiche DANS NDF Express.
  // Le signet reste ainsi actif pendant la connexion et s'ouvre tout seul ensuite.
  function waitForLogin() {
    S.waiting = true; S.user = null; S.error = null; S.busy = false;
    host.style.cssText = FULL; render();
    if (waitTimer) return;
    waitTimer = setInterval(function () {
      var frame = root.getElementById('login-frame');
      var path = '';
      try { path = frame.contentWindow.location.pathname; } catch (e) {}
      if (path.charAt(0) !== '/' || path.indexOf('/login') === 0 || !csrfToken()) return;
      clearInterval(waitTimer); waitTimer = null;
      reloadOnClose = true; // la page Boond derrière est restée sur l'écran de connexion
      setTimeout(function () { S.waiting = false; refresh(); }, 600);
    }, 1000);
  }
  var root = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
    '.app,.bw{--bg:#F4F5F7;--card:#FFFFFF;--line:#E7E8EC;--text:#14151A;--muted:#686C78;--accent:#3B4BDB;--on-accent:#fff;--tint:#E5E8FF;--on-tint:#111650;--ok:#1F9D5B;--warn:#B7791F;--err:#D63B3B;--neutral:#8A8F9C;',
    'position:absolute;inset:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow-y:auto;-webkit-overflow-scrolling:touch}',
    '@media (prefers-color-scheme:dark){.app,.bw{--bg:#0D0E12;--card:#17191F;--line:#22252D;--text:#ECEDF2;--muted:#9A9EAB;--accent:#9AA4FF;--on-accent:#0C0F24;--tint:#242A55;--on-tint:#DDE1FF;--ok:#2FBF71;--warn:#E0A030;--err:#FF7A7A}}',
    '.bw{position:static;inset:auto;background:transparent;overflow:visible;padding:0 12px calc(env(safe-area-inset-bottom) + 12px)}',
    '.banner{display:flex;align-items:center;gap:12px;max-width:560px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px 14px;box-shadow:0 10px 30px rgba(0,0,0,.18)}',
    '.wrap{max-width:560px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 14px) 16px calc(env(safe-area-inset-bottom) + 110px)}',
    '.top{display:flex;align-items:center;gap:8px;margin-bottom:6px}.top h1{font-size:24px;font-weight:600;letter-spacing:-.3px;margin:0;flex:1}',
    '.sub{color:var(--muted);font-size:13px;margin:0}',
    '.icon{border:0;background:transparent;color:var(--muted);font-size:14px;padding:8px 10px;border-radius:10px;cursor:pointer}',
    '.label{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);margin:20px 4px 8px}',
    '.card{background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden}',
    '.row{display:flex;align-items:center;gap:12px;padding:13px 16px;border-top:1px solid var(--line)}.row:first-child{border-top:0}',
    '.grow{flex:1;min-width:0}.small{font-size:12px;color:var(--muted)}',
    '.month{display:flex;align-items:center;padding:14px 6px}.month .grow{text-align:center}.month b{display:block;font-size:28px;font-weight:600;letter-spacing:-.5px}',
    '.nav{border:0;background:transparent;color:var(--text);font-size:26px;width:44px;height:44px;border-radius:12px;cursor:pointer}',
    'select{width:100%;font:inherit;font-size:16px;color:var(--text);background:transparent;border:0;padding:2px 0;-webkit-appearance:none;appearance:none}',
    '.switch{position:relative;width:46px;height:28px;flex:none}.switch input{opacity:0;width:0;height:0}',
    '.switch span{position:absolute;inset:0;background:var(--line);border-radius:99px;transition:.2s}.switch span:before{content:"";position:absolute;width:22px;height:22px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}',
    '.switch input:checked+span{background:var(--accent)}.switch input:checked+span:before{transform:translateX(18px)}',
    '.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:99px;background:var(--tint);color:var(--on-tint);font:600 14px/1 inherit;padding:12px 16px;cursor:pointer}',
    '.primary{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom) + 14px);width:calc(100% - 32px);max-width:528px;border:0;border-radius:16px;background:var(--accent);color:var(--on-accent);font:600 16px/1 inherit;padding:19px;cursor:pointer}',
    '.primary:disabled{opacity:.45}.link{border:0;background:transparent;color:var(--accent);font:inherit;font-size:14px;padding:10px;cursor:pointer}',
    '.thumbs{display:flex;gap:10px;overflow-x:auto;padding:14px 16px 4px}.thumb{position:relative;flex:none;width:72px;height:72px;border-radius:12px;background:var(--line) center/cover no-repeat;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--muted)}',
    '.thumb button{position:absolute;top:4px;right:4px;width:22px;height:22px;border:0;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:13px;line-height:22px;padding:0;cursor:pointer}',
    '.pill{display:inline-flex;align-items:center;gap:5px;border-radius:99px;padding:2px 9px;font-size:11px;font-weight:600;white-space:nowrap}.pill:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}',
    '.mini{width:48px;height:48px;border-radius:10px;background:var(--line) center/cover no-repeat;flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted)}',
    '.amount{font-weight:600}.strike{text-decoration:line-through;color:var(--muted);font-size:13px;margin-left:6px;font-weight:400}',
    '.bar{height:4px;background:var(--tint);border-radius:99px;margin:10px 4px 6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent);transition:width .3s}',
    '.big{font-size:32px;font-weight:600;letter-spacing:-.5px}.warn{color:var(--warn);font-size:12px;margin-top:8px}.info{color:var(--accent);font-size:12px;margin-top:6px}',
    '.err{background:var(--card);border:1px solid var(--err);color:var(--err);border-radius:14px;padding:12px 14px;margin:12px 0;font-size:14px}',
    '.edit{display:flex;gap:8px;padding:0 16px 14px;flex-wrap:wrap}.edit input{flex:1;min-width:120px;font:inherit;font-size:16px;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px}',
    '.done{text-align:center;padding-top:60px}.check{width:84px;height:84px;border-radius:50%;margin:0 auto 22px;display:flex;align-items:center;justify-content:center;font-size:40px;color:var(--ok);background:color-mix(in srgb,var(--ok) 15%,transparent)}',
    'textarea{width:100%;height:300px;font:11px/1.4 ui-monospace,Menlo,monospace;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px}',
    '.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:s .8s linear infinite;vertical-align:-1px;margin-right:6px}@keyframes s{to{transform:rotate(360deg)}}'
  ].join('');

  function pill(item) {
    var map = {
      pending: ['En attente', 'var(--neutral)'], uploading: ['Lecture…', 'var(--accent)'],
      ready: [item.capped ? 'Prêt · plafonné' : 'Prêt', 'var(--ok)'], needs: ['À compléter', 'var(--warn)'],
      outofmonth: ['Hors mois', 'var(--neutral)'], duplicate: ['Doublon ?', 'var(--warn)'], error: ['Erreur', 'var(--err)']
    };
    var p = map[item.status];
    return '<span class="pill" style="color:' + p[1] + ';background:color-mix(in srgb,' + p[1] + ' 14%,transparent)">' + p[0] + '</span>';
  }

  function mini(item) {
    return item.thumb ? '<div class="mini" style="background-image:url(' + item.thumb + ')"></div>' : '<div class="mini">PDF</div>';
  }

  function itemRow(item, withControls) {
    var amount = '';
    if (item.finalAmount != null) {
      amount = '<span class="amount">' + euro(item.finalAmount) + '</span>' + (item.capped && item.ticketAmount != null ? '<span class="strike">' + euro(item.ticketAmount) + '</span>' : '');
    } else if (item.ticketAmount != null) amount = euro(item.ticketAmount);
    var toggle = withControls && (item.status === 'ready' || item.status === 'duplicate')
      ? '<label class="switch"><input type="checkbox" data-toggle="' + item.id + '"' + (item.included ? ' checked' : '') + '><span></span></label>' : '';
    var editable = withControls && item.documentId ? ' data-act="edit" data-id="' + item.id + '" style="cursor:pointer"' : '';
    var html = '<div class="row"><div' + editable + ' style="display:flex;gap:12px;align-items:center;flex:1;min-width:0' + (editable ? ';cursor:pointer' : '') + '">' + mini(item) +
      '<div class="grow"><div style="display:flex;gap:8px;align-items:center"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      esc(item.date ? frDate(item.date) : item.file.name) + '</span>' + pill(item) + '</div>' +
      (amount ? '<div>' + amount + '</div>' : '') + (item.message ? '<div class="small">' + esc(item.message) + '</div>' : '') +
      '</div></div>' + toggle + '</div>';
    if (withControls && S.editing === item.id) {
      html += '<div class="edit"><input type="date" id="ed-date" value="' + esc(item.date || '') + '">' +
        '<input type="text" inputmode="decimal" id="ed-amount" placeholder="Montant TTC" value="' + (item.ticketAmount != null ? String(item.ticketAmount).replace('.', ',') : '') + '">' +
        '<button class="btn" data-act="save-edit" data-id="' + item.id + '">Valider</button></div>';
    }
    return html;
  }

  function header(title, subtitle, back) {
    return '<div class="top">' + (back ? '<button class="icon" data-act="' + back + '" aria-label="Retour" style="font-size:22px;color:var(--text)">‹</button>' : '') +
      '<h1>' + esc(title) + '</h1><button class="icon" data-act="diag">Détails</button><button class="icon" data-act="close" aria-label="Fermer" style="font-size:22px">✕</button></div>' +
      (subtitle ? '<p class="sub">' + esc(subtitle) + '</p>' : '');
  }

  function viewHome() {
    var n = S.items.length;
    var detail = S.busy ? '<span class="spin"></span>Chargement de la note…'
      : !S.reportId ? 'Pas encore de note pour ce mois'
      : esc(S.reportRefLabel) + ' · ' + linesOf(S.report).length + ' ligne(s) · ' + euro(linesOf(S.report).reduce(function (s, l) { return s + (num(l.amountIncludingTax) || 0); }, 0));
    var typeOptions = S.types.map(function (t) { return '<option value="' + esc(t.reference) + '"' + (t.reference === prefs.type ? ' selected' : '') + '>' + esc(t.label) + '</option>'; }).join('');
    var impOptions = S.imputations.map(function (i) { return '<option value="' + esc(i.key) + '"' + (i.key === prefs.imputation ? ' selected' : '') + '>' + esc(i.label) + '</option>'; }).join('');
    var thumbs = S.items.map(function (it) {
      return '<div class="thumb"' + (it.thumb ? ' style="background-image:url(' + it.thumb + ')"' : '') + '>' + (it.thumb ? '' : 'PDF') +
        '<button data-act="remove" data-id="' + it.id + '" aria-label="Retirer">✕</button></div>';
    }).join('');
    var cta = n === 0 ? 'Ajoute des justificatifs' : (prefs.simulation ? 'Lancer en simulation · ' + n : 'Lancer · ' + n + ' justificatif' + (n > 1 ? 's' : ''));
    return '<div class="wrap">' + header('NDF Express', S.user ? S.user.name : 'Connexion à Boond…') +
      '<div class="card" style="margin-top:12px"><div class="month"><button class="nav" data-act="prev" aria-label="Mois précédent">‹</button><div class="grow"><b>' +
      monthLabel(S.term) + '</b><span class="small">' + detail + '</span></div><button class="nav" data-act="next" aria-label="Mois suivant">›</button></div>' +
      '<div style="text-align:center;padding-bottom:6px"><button class="link" data-act="refresh">Actualiser</button></div></div>' +
      '<div class="label">Règles du lot</div><div class="card">' +
      '<div class="row"><div class="grow"><div class="small">Type de frais</div><select data-field="type">' + (typeOptions || '<option>Aucun type trouvé</option>') + '</select></div><span class="small">▾</span></div>' +
      '<div class="row"><div class="grow"><div class="small">Projet / prestation</div><select data-field="imputation">' + (impOptions || '<option>Aucun projet trouvé</option>') + '</select></div><span class="small">▾</span></div>' +
      '<div class="row"><div class="grow"><div>Plafonner à ' + euro(prefs.capAmount) + '</div><div class="small">Un ticket plus cher est saisi à ' + euro(prefs.capAmount) + ' TTC</div></div><label class="switch"><input type="checkbox" data-field="cap"' + (prefs.cap ? ' checked' : '') + '><span></span></label></div>' +
      '<div class="row"><div class="grow"><div>Mode simulation</div><div class="small">Lit les tickets et prépare les lignes sans les enregistrer</div></div><label class="switch"><input type="checkbox" data-field="simulation"' + (prefs.simulation ? ' checked' : '') + '><span></span></label></div>' +
      '</div>' +
      '<div class="label">Justificatifs' + (n ? ' · ' + n : '') + '</div><div class="card">' +
      (n ? '<div class="thumbs">' + thumbs + '</div>' : '<p class="small" style="padding:14px 16px 0;margin:0">Choisis tes tickets (photos ou PDF). Boond les lira un par un.</p>') +
      '<div style="display:flex;gap:10px;padding:14px 16px"><label class="btn" style="flex:1">+ Ajouter des tickets<input type="file" accept="image/*,application/pdf" multiple data-field="files" style="display:none"></label>' +
      (n ? '<button class="link" data-act="clear">Tout retirer</button>' : '') + '</div></div>' +
      '<button class="primary" data-act="start"' + (n && !S.busy ? '' : ' disabled') + '>' + cta + '</button></div>';
  }

  function viewProcessing() {
    var done = S.items.filter(function (i) { return i.status !== 'pending' && i.status !== 'uploading'; }).length;
    var pct = S.items.length ? Math.round(done * 100 / S.items.length) : 0;
    return '<div class="wrap">' + header('Lecture des tickets', done + ' sur ' + S.items.length + ' · lecture par Boond (Mindee)') +
      '<div class="bar"><i style="width:' + pct + '%"></i></div><div class="card">' + S.items.map(function (i) { return itemRow(i, false); }).join('') + '</div>' +
      '<button class="primary" data-act="stop">Arrêter</button></div>';
  }

  function viewReview() {
    var list = sendable();
    var total = list.reduce(function (s, i) { return s + i.finalAmount; }, 0);
    var count = function (st) { return S.items.filter(function (i) { return i.status === st; }).length; };
    var others = [[count('needs'), 'à compléter'], [S.items.filter(function (i) { return i.status === 'duplicate' && !i.included; }).length, 'doublon(s) écarté(s)'],
      [count('outofmonth'), 'hors mois'], [count('error'), 'erreur(s)']].filter(function (o) { return o[0] > 0; })
      .map(function (o) { return o[0] + ' ' + o[1]; }).join(' · ');
    var imp = selectedImputation(), type = selectedType();
    var errors = count('error'), pending = count('pending');
    var cta = !list.length ? 'Aucune ligne à envoyer' : prefs.simulation ? 'Simuler l\'envoi · ' + list.length : 'Ajouter ' + list.length + ' ligne' + (list.length > 1 ? 's' : '') + ' à Boond';
    return '<div class="wrap">' + header('Récapitulatif', monthLabel(S.term) + ' · ' + (type ? type.label : ''), 'back') +
      '<div class="card" style="padding:18px;margin-top:12px"><div class="big">' + euro(total) + '</div><div class="small">' + list.length + ' ligne(s) à ajouter · ' + esc(imp ? imp.label : '') + '</div>' +
      (others ? '<div class="warn">' + others + '</div>' : '') + (prefs.simulation ? '<div class="info">Mode simulation actif : rien ne sera enregistré dans la note.</div>' : '') + '</div>' +
      (errors ? '<div style="text-align:center"><button class="link" data-act="retry">Réessayer les ' + errors + ' erreur(s)</button></div>' : '') +
      (pending ? '<div style="text-align:center"><button class="link" data-act="resume">Reprendre la lecture (' + pending + ')</button></div>' : '') +
      '<div class="label">Touche une ligne pour la corriger</div><div class="card">' + S.items.map(function (i) { return itemRow(i, true); }).join('') + '</div>' +
      '<button class="primary" data-act="submit"' + (list.length && !S.busy ? '' : ' disabled') + '>' + (S.busy ? '<span class="spin"></span>Envoi…' : cta) + '</button></div>';
  }

  function viewDone() {
    return '<div class="wrap">' + header('NDF Express') + '<div class="done"><div class="check">✓</div><div class="big" style="font-size:24px">' +
      (prefs.simulation ? 'Simulation terminée' : 'C\'est dans Boond') + '</div><p class="sub" style="font-size:15px;margin:12px 8px">' + esc(S.result) + '</p>' +
      (prefs.simulation ? '' : '<p class="sub">Vérifie la note dans Boond puis soumets-la comme d\'habitude.</p>') + '</div>' +
      '<button class="primary" data-act="new">Nouveau lot</button></div>';
  }

  function viewDiag() {
    var text = '— Journal —\n' + logLines.join('\n') +
      (S.lastUpload ? '\n\n— Dernière réponse d\'upload (OCR) —\n' + S.lastUpload : '') +
      (S.lastPayload ? '\n\n— Dernier envoi de lignes —\n' + S.lastPayload : '');
    return '<div class="wrap">' + header('Détails techniques', 'Ne contient ni ton mot de passe ni ta session', 'hide-diag') +
      '<textarea readonly id="diag">' + esc(text) + '</textarea><div style="display:flex;gap:10px;margin-top:10px"><button class="btn" data-act="copy">Copier</button></div></div>';
  }

  function render() {
    if (S.waiting) {
      if (root.getElementById('login-frame')) return; // ne pas recharger la connexion en cours
      root.innerHTML = '<style>' + CSS + '</style><div class="app" style="display:flex;flex-direction:column">' +
        '<div class="wrap" style="padding-bottom:10px;width:100%">' + header('Connexion à Boond', 'Connecte-toi : NDF Express s\'ouvrira juste après.') + '</div>' +
        '<iframe id="login-frame" src="/login" title="Connexion à Boond" style="flex:1;width:100%;border:0;border-top:1px solid var(--line);background:#fff"></iframe></div>';
      return;
    }
    var view = S.showDiag ? viewDiag()
      : S.screen === 'processing' ? viewProcessing()
      : S.screen === 'review' ? viewReview()
      : S.screen === 'done' ? viewDone() : viewHome();
    var scroll = root.querySelector('.app') ? root.querySelector('.app').scrollTop : 0;
    root.innerHTML = '<style>' + CSS + '</style><div class="app">' +
      (S.error ? '<div class="wrap" style="padding-bottom:0"><div class="err">' + esc(S.error) + ' <button class="link" data-act="dismiss" style="padding:0 0 0 6px">OK</button></div></div>' : '') +
      view + '</div>';
    var app = root.querySelector('.app');
    if (app) app.scrollTop = scroll;
  }

  root.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var id = parseInt(el.getAttribute('data-id'), 10);
    var item = S.items.filter(function (i) { return i.id === id; })[0];
    switch (act) {
      case 'close':
        if (S.waiting) { if (waitTimer) { clearInterval(waitTimer); waitTimer = null; } S.waiting = false; root.innerHTML = ''; }
        host.style.display = 'none';
        if (reloadOnClose) location.reload();
        break;
      case 'diag': S.showDiag = true; render(); break;
      case 'hide-diag': S.showDiag = false; render(); break;
      case 'copy':
        var ta = root.getElementById('diag');
        if (navigator.clipboard) navigator.clipboard.writeText(ta.value).then(function () { el.textContent = 'Copié'; });
        else { ta.select(); document.execCommand('copy'); el.textContent = 'Copié'; }
        break;
      case 'dismiss': S.error = null; render(); break;
      case 'prev': if (!S.processing) { S.term = addMonths(S.term, -1); refresh(); } break;
      case 'next': if (!S.processing) { S.term = addMonths(S.term, 1); refresh(); } break;
      case 'refresh': refresh(); break;
      case 'remove': if (item && item.thumb) URL.revokeObjectURL(item.thumb); S.items = S.items.filter(function (i) { return i.id !== id; }); render(); break;
      case 'clear': S.items.forEach(function (i) { if (i.thumb) URL.revokeObjectURL(i.thumb); }); S.items = []; render(); break;
      case 'start': start(false); break;
      case 'resume': start(false); break;
      case 'retry': start(true); break;
      case 'stop': stopRequested = true; break;
      case 'back': S.screen = 'home'; S.editing = null; render(); break;
      case 'edit': S.editing = S.editing === id ? null : id; render(); break;
      case 'save-edit':
        var dateVal = root.getElementById('ed-date').value;
        var amountVal = num(root.getElementById('ed-amount').value);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVal) || amountVal == null || amountVal <= 0) { S.error = 'Indique une date et un montant TTC valides.'; render(); break; }
        Object.assign(item, { status: 'ready', date: dateVal, ticketAmount: round2(amountVal) });
        evaluate(item); S.editing = null; render(); break;
      case 'submit': submit(); break;
      case 'new': newBatch(); break;
    }
  });

  root.addEventListener('change', function (e) {
    var t = e.target;
    var field = t.getAttribute('data-field');
    var toggleId = t.getAttribute('data-toggle');
    if (toggleId) {
      var it = S.items.filter(function (i) { return i.id === parseInt(toggleId, 10); })[0];
      if (it) it.included = t.checked;
      render(); return;
    }
    if (field === 'type') { prefs.type = t.value; savePrefs(); }
    else if (field === 'imputation') { prefs.imputation = t.value; savePrefs(); }
    else if (field === 'cap') { prefs.cap = t.checked; savePrefs(); S.items.forEach(evaluate); render(); }
    else if (field === 'simulation') { prefs.simulation = t.checked; savePrefs(); render(); }
    else if (field === 'files') { addFiles(t.files); t.value = ''; }
  });

  window.__ndfExpress = {
    show: function () {
      host.style.display = '';
      if (S.waiting) { render(); return; }
      if (!loggedIn()) { waitForLogin(); return; }
      // Signet touché à nouveau après une connexion : on charge tout.
      if (!S.user) { S.error = null; refresh(); } else render();
    }
  };

  if (loggedIn()) { render(); refresh(); } else waitForLogin();
})();
