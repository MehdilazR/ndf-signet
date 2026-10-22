# NDF Express — signet

Script du signet NDF Express pour BoondManager : il s'ouvre par-dessus la page
Boond (ui.boondmanager.com), dans la session du navigateur, et ajoute des notes
de frais en lot à partir de photos de tickets (lecture par l'OCR de Boond).

- `ndf.js` : version chargée par le signet (minifiée) ;
- `ndf-express.source.js` : code source lisible.

Ce dépôt ne contient ni identifiant, ni clé, ni donnée personnelle.

Code du signet (à coller comme adresse d'un favori) :

```
javascript:(function(){var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/MehdilazR/ndf-signet@main/ndf.js?t='+Date.now();document.body.appendChild(s)})()
```
