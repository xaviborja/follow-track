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
- **Progreso**: porcentaje recorrido, kilómetros que faltan y **desnivel positivo que
  queda** hasta el final. Antes de empezar las dos últimas cifras muestran el total de la
  ruta, y van bajando conforme avanzas. El desnivel restante se calcula sobre la subida
  acumulada del track, no como diferencia de altitud, así que cuenta los repechos.
- **Subidas principales**: bajo el perfil aparece la lista de subidas de la ruta, con
  desnivel, distancia, pendiente media, rampa máxima y altitud de coronación. Tocando una
  se enmarca en el mapa y se resalta en el perfil. Se detectan buscando cimas y valles con
  prominencia (una cima cuenta si después se baja al menos 12 m de ella, para que el ruido
  del GPS no genere cien repechos), fusionando las separadas por un bajón pequeño —un
  puerto con un falso llano en medio es un puerto, no dos— y descartando lo que no llega a
  50 m de desnivel, 200 m de largo o un 3 % de media. Los extremos llanos se recortan, que
  si no un kilómetro de aproximación hunde la pendiente media. Los umbrales están en
  `DEFAULTS`, al principio de `js/climbs.js`.
- **Perfil de elevación** (botón «Ver perfil»): la altitud de toda la ruta, partida por el
  punto donde estás — azul lo recorrido, naranja lo que falta, igual que en el mapa — con
  la altitud actual y el desnivel positivo que queda. Arrastrando el dedo por el perfil se
  consulta cualquier punto (km y altitud) y se marca a la vez en el mapa. La altitud del
  GPS es ruidosa, así que se suaviza antes de dibujarla y de contar el desnivel; los
  valores y por qué son esos están más abajo.
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
- El track se guarda en `localStorage`; uno de más de ~4 MB no se guardará, aunque sí se
  carga y funciona en esa sesión. Una carrera de 100 km ocupa unos 0,65 MB.

## Por qué las cifras pueden no coincidir con Wikiloc o con tu reloj

**La distancia sí debería coincidir.** Los tracks grabados con el móvil traen un punto
cada uno o dos metros, y a esa densidad lo que se mide entre punto y punto es el error
del GPS, no el avance: sumarlos tal cual da varios kilómetros de más en una ruta larga.
Por eso se descartan los pasos de menos de 3 m (`MIN_STEP` en `js/geo.js`), que no se ven
ni al máximo zoom. Con la Ultra Pirineu 2025 salen 100,34 km frente a los 100,32 de
Wikiloc.

**El desnivel acumulado no coincide nunca entre herramientas, y es normal.** Depende de
cuánto suavice cada una la altitud antes de sumar. Aquí se usa una media móvil de ±20 m
y un umbral de 2 m: por debajo de eso es deriva del barómetro, no desnivel. Wikiloc suma
casi en crudo, con un umbral de alrededor de 1 m, y le salen cifras un 4 % más altas.

Esos dos valores no están elegidos a ojo: se midieron varias combinaciones contra dos
carreras reales y contra una ruta llana con ruido de ±3 m punto a punto, que debería dar
cero. Suavizar poco cuadra mejor con las carreras pero hace que el ruido invente
desnivel; suavizar mucho lo aplana todo.

| ventana / umbral | Ultra Pirineu (Wikiloc 5.936) | Volta del Gegant (ficha 1.800) | llano con ruido (ideal 0) |
|---|---|---|---|
| ±10 m / 2 m | 5.756 (−3,0 %) | 1.823 (+1,3 %) | 368 m falsos |
| **±20 m / 2 m** | **5.675 (−4,4 %)** | **1.780 (−1,1 %)** | **30 m falsos** |
| ±30 m / 3 m | 5.545 (−6,6 %) | 1.737 (−3,5 %) | 0 m falsos |

Si prefieres cifras más altas o más bajas, los dos parámetros están juntos en
`elevationProfile`, en `js/geo.js`.

## Estructura

```
index.html                 interfaz
css/app.css                estilos
js/app.js                  mapa, GPS, avisos y UI
js/geo.js                  haversine, distancia punto-segmento, progreso sobre el track
js/parse.js                lectura de GPX / KML / TCX / GeoJSON
js/climbs.js               detección de las subidas principales
js/profile.js              perfil de elevación en canvas, con consulta al arrastrar
sw.js                      service worker (offline + caché de tiles)
manifest.webmanifest       instalación como app
vendor/leaflet/            Leaflet 1.9.4 en local, para que funcione sin red
samples/                   track de ejemplo
selftest.html              comprobación manual
```

## Cómo se actualiza la app instalada

Los ficheros de la app (HTML, CSS, JS) se piden **a la red primero**, revalidando
contra el servidor, y la caché queda solo como respaldo para cuando no hay cobertura.
Los tiles del mapa y Leaflet, que no cambian, sí van de caché primero.

Esto es deliberado. La primera versión servía todo de caché primero: cada fichero se
refrescaba por su cuenta y la app llegó a mezclar un HTML nuevo con un JavaScript
viejo, con un botón visible que no hacía nada. Con red primero no pueden convivir dos
versiones, y las 35 KB de la app no se notan al abrirla.

Al publicar cambios, sube `VERSION` en `sw.js`: sirve para descartar la caché anterior
y volver a precargar la lista de ficheros. Los móviles ya instalados cogen el service
worker nuevo al abrir la app y se recargan una vez, solos.
