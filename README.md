# HDR Fusion

Fusion HDR par lots de brackets RAW, pensée pour la Ricoh Theta Z1. Application Electron pour macOS.

Déposez un dossier : les vues prises au même instant sont regroupées en séries, et chaque série devient un DNG HDR.

## Moteurs

- **LightCraft** : fusionne, développe avec des réglages jour ou nuit choisis selon l'exposition de la série, puis exporte un TIFF 16 bits ou un JPEG en plus du DNG. LightCraft est piloté par son canal de contrôle, dans une session temporaire qui ne touche pas à la bibliothèque.
- **HDRMerge** : fusion seule, en DNG flottant plus léger.

Netteté et réduction du bruit sont désactivées dans les réglages de développement : le débruitage se fait ensuite, sur une image non accentuée.

## Prérequis

- macOS, Node.js 20 ou plus récent
- `/Applications/LightCraft.app` et/ou `/Applications/HDRMerge.app`

## Lancer

```sh
npm install
npm start
npm start -- /chemin/vers/un/dossier
```

## Presets

`presets/Theta HDR.lcpreset` contient les deux réglages (Theta HDR Jour, Theta HDR Nuit) à importer dans LightCraft pour un usage manuel. Ils ont été réglés sur des fusions faites par LightCraft, pas sur les DNG de HDRMerge, qui sortent plus sombres.
