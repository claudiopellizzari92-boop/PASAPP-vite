# Porta Al Sole — App (Vite)

App de gestión del edificio Porta Al Sole, migrada a Vite.

## Archivos que faltan agregar a /public

Antes de subir, copiá estos archivos (los tenés en tu repo actual) a la carpeta `public/`:
- apple-touch-icon.png
- icon-192.png
- icon-512.png
- customcolor_text-logoname_transparent_background.png
- customcolor_icon_transparent_background.png
- manifest.json

(El sw.js ya está incluido en public/)

## Desarrollo local
```
npm install
npm run dev
```

## Build de producción
```
npm run build
```
Genera la carpeta `dist/` lista para publicar.

## Netlify
El netlify.toml ya está configurado: build command `npm run build`, publish `dist`.
