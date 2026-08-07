# Follow Track

App para cargar un track (GPX, KML, TCX o GeoJSON), verlo en el mapa y comprobar
en tiempo real si lo estás siguiendo. Es una PWA: el mismo código funciona en el
navegador de escritorio y se instala en Android como una app más.

No tiene dependencias ni proceso de build: son ficheros estáticos.

## Qué hace

- Carga de track desde fichero (botón, arrastrar y soltar, o `?track=ruta.gpx` en la URL).
- Dibuja el track en el mapa: naranja lo que falta, azul lo ya recorrido, e inicio/final marcados.
- **Desvío**: distancia perpendicular al track, siempre visible y en tiempo real.
- **Aviso al salirse**: banner rojo, vibración y pitido si te alejas más del umbral
  configurado (10–500 m). Se repite cada 25 s mientras sigas fuera y se puede silenciar.
  Vuelve al estado normal al acercarte al 70 % del umbral (histéresis, para que no
  parpadee cuando vas justo en el límite).
- **Progreso**: porcentaje recorrido y kilómetros que faltan hasta el final.
- **Perfil de elevación** (botón «Ver perfil»): la altitud de toda la ruta, partida por el
  punto donde estás — azul lo recorrido, naranja lo que falta, igual que en el mapa — con
  la altitud actual y el desnivel positivo que queda. Arrastrando el dedo por el perfil se
  consulta cualquier punto (km y altitud) y se marca a la vez en el mapa. La altitud del
  GPS es ruidosa, así que se suaviza con una media móvil de ±30 m antes de dibujarla y de
  contar el desnivel, con un umbral de 3 m para no inflar la subida acumulada.
- El último track queda guardado: al reabrir la app sigue ahí.
- Funciona sin cobertura: la app se cachea entera y los tiles del mapa que ya has
  visto se guardan (hasta ~1200 tiles). Conviene abrir la zona con wifi antes de salir.
- Mantiene la pantalla encendida mientras el GPS está activo.
- **Modo prueba** (en ajustes): tocar el mapa fija tu posición, para probarlo desde el sofá.

## Probar en local

```bash
python3 -m http.server 8777
```

Y abre <http://127.0.0.1:8777/>. En `localhost` la geolocalización funciona aunque
no haya HTTPS. Hay un track de ejemplo en `samples/ejemplo-collserola.gpx`.

`selftest.html` es una página de comprobación: carga la app en un iframe, parsea los
formatos soportados y simula posiciones dentro y fuera del track. Ábrela tras tocar
código para ver que todo sigue bien.

## Publicar y usarlo en Android

La geolocalización exige HTTPS (salvo en `localhost`), así que **no basta con abrir
la carpeta desde el móvil ni servirla por IP local**: hay que publicarla. Lo más
directo:

- **GitHub Pages**: sube la carpeta a un repo y actívalo en *Settings → Pages*.
- **Netlify / Cloudflare Pages**: arrastra la carpeta a su panel; ambos dan HTTPS.

Ya publicada, en el móvil: abre la URL en Chrome → menú ⋮ → *Añadir a pantalla de
inicio*. Queda con icono propio y a pantalla completa. La primera vez que pulses
*Iniciar GPS* pedirá permiso de ubicación; dale «Mientras se usa la app».

Si además quieres un APK instalable, se puede envolver con Capacitor sin tocar este
código, pero para el uso normal no hace falta.

## Limitaciones que conviene saber

- **En segundo plano no registra nada.** Si bloqueas la pantalla o cambias de app,
  Android congela la página y los avisos dejan de sonar. Por eso la app mantiene la
  pantalla encendida. Para seguimiento con la pantalla apagada haría falta una app
  nativa.
- Los tiles vienen de OpenStreetMap, cuya política es para uso personal y con poco
  tráfico. Si lo vais a usar varias personas, cambia la URL del tile layer en
  `js/app.js:28` por un proveedor con clave (Thunderforest, MapTiler…).
- Los KMZ van comprimidos: descomprime y carga el `.kml` de dentro.
- El track se guarda en `localStorage`; uno de más de ~4 MB (unos 100.000 puntos) no
  se guardará, aunque sí se carga y funciona en esa sesión.

## Estructura

```
index.html                 interfaz
css/app.css                estilos
js/app.js                  mapa, GPS, avisos y UI
js/geo.js                  haversine, distancia punto-segmento, progreso sobre el track
js/parse.js                lectura de GPX / KML / TCX / GeoJSON
js/profile.js              perfil de elevación en canvas, con consulta al arrastrar
sw.js                      service worker (offline + caché de tiles)
manifest.webmanifest       instalación como app
vendor/leaflet/            Leaflet 1.9.4 en local, para que funcione sin red
samples/                   track de ejemplo
selftest.html              comprobación manual
```

Al tocar `sw.js` o los ficheros de la app, sube `VERSION` en `sw.js` para que los
móviles ya instalados se actualicen.
