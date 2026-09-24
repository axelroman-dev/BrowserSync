# BrowserSync — cómo se manejan tus datos

Este es un servicio autoalojado pequeño e informal, no un producto comercial. Este
documento explica, en lenguaje simple, qué pasa con tus datos si usas esta
herramienta. Si algo no queda claro, pregúntale a quien te dio la URL del servidor.

## Qué se guarda en el servidor

- Tu **email** y un **hash de tu contraseña** (no tu contraseña real — pasa por un
  algoritmo de hash de una sola vía, argon2id, antes de guardarse).
- Un **hash de tu passphrase de recuperación** (no la passphrase en sí — el mismo tipo
  de hash de una sola vía, y calculado de forma totalmente separada del cálculo que
  realmente protege tus datos, así que este hash no sirve para descifrar nada). Solo
  existe para que el servidor pueda confirmar "sí, esa es la passphrase de recuperación
  correcta" si alguna vez necesitas restablecer una contraseña olvidada.
- Tu **clave de datos envuelta ("wrapped")**: la clave que realmente cifra tus
  marcadores/historial no es tu passphrase ni tu contraseña — es una clave aleatoria,
  generada en tu dispositivo, que queda encerrada dentro de un "sobre" cifrado usando
  una clave derivada de tu passphrase. Ese sobre es lo que se guarda aquí. Es seguro
  guardarlo: abrirlo requiere tu passphrase, que el servidor nunca llega a conocer.
- **Blobs cifrados** de tus marcadores, (si lo activas) tu historial de navegación y
  las contraseñas que guardes en la bóveda de contraseñas de la extensión, cifrados en tu propio dispositivo con esa clave de datos antes de enviarse a
  cualquier lado.
- Marcas de tiempo de cuándo sincronizaste por última vez, y el tamaño aproximado de
  cada blob cifrado.
- Si tienes sesión iniciada en más de un dispositivo, una fila por dispositivo que
  registra cuándo usó su sesión por última vez — esto es lo que permite cerrar sesión
  en un solo dispositivo perdido/viejo sin cerrar sesión en todos los demás.

## Qué NO se guarda en el servidor

- **El contenido real de tus marcadores o historial, en forma legible.** Lo que llega
  al servidor es texto cifrado (ciphertext) — sin sentido sin la clave de datos descrita
  arriba. Nadie puede leer los títulos de tus marcadores, URLs, o historial de
  navegación desde el servidor o su base de datos — ni alguien que robe la base de
  datos, ni el administrador (ver abajo).
- Tu contraseña, en cualquier forma legible.
- Tu passphrase de recuperación, en cualquier forma legible o reversible.
- También existe una segunda copia de tu clave de datos, envuelta con tu contraseña —
  pero solo en cada uno de *tus propios dispositivos* (en el almacenamiento local de la
  extensión), nunca en el servidor. Eso es lo que permite que tu contraseña desbloquee
  BrowserSync en el día a día sin que el servidor pueda hacer lo mismo.
- Las contraseñas que guarda tu propio navegador, ni sus datos de autocompletado.
  BrowserSync no puede leerlos; solo guarda las contraseñas que guardes en su propia
  bóveda (cifradas, ver arriba). Si activas las sugerencias en páginas, la extensión lee
  el usuario y la contraseña de un formulario de inicio de sesión al enviarlo, solo para
  ofrecerte guardarlos: se quedan en tu dispositivo salvo que pulses Guardar, y entonces
  se cifran antes de subirse como todo lo demás.

## Qué puede y qué no puede ver el administrador

Quien administre este servidor (técnicamente) tiene acceso normal a la base de
datos — eso es inevitable para cualquiera que se autoaloje un servicio. En concreto,
el administrador:

- **Puede ver:** que existe una cuenta con tu email, aproximadamente qué tan grandes
  son tus datos sincronizados, y cuándo sincronizaste por última vez.
- **No puede ver:** tus marcadores, tu historial de navegación, ni nada dentro de tus
  blobs cifrados — incluso con acceso directo a la base de datos. El administrador sí
  ve tu contraseña en texto plano en el momento en que inicias sesión (así funciona
  cualquier login basado en contraseña), pero eso solo no basta para descifrar tus
  datos: la copia de tu clave de datos envuelta con tu contraseña vive solo en tus
  propios dispositivos, nunca en el servidor. Esto es "cifrado de extremo a extremo":
  el servidor solo transmite texto cifrado (y un sobre que solo tu passphrase puede
  abrir) que no puede leer por sí mismo.

Esto también significa: **si pierdes tanto tu contraseña como tu passphrase de
recuperación, nadie puede recuperar tus datos sincronizados, ni siquiera el
administrador.** No existe una opción de "restablecer passphrase", a propósito — una
vía de recuperación para la passphrase misma significaría que alguien más además de ti
podría descifrar tus datos.

## Copias de seguridad (backups)

La base de datos (incluyendo tu cuenta, blobs cifrados, y credenciales con hash) se
respalda regularmente. Un backup contiene la misma información que la base de datos
en vivo — tampoco expone el contenido de tus marcadores/historial en texto plano, ya
que los blobs ya están cifrados antes de guardarse.

- **Frecuencia de backup:** _[admin: completar, ej. "diario a las 3am"]_
- **Retención:** _[admin: completar, ej. "se conservan los últimos 14 backups
  diarios"]_
- **Dónde se guardan los backups:** _[admin: completar, ej. "en el mismo NAS del
  homelab, en un disco separado de la base de datos en vivo"]_

## Borrar tu cuenta

Puedes borrar tu cuenta y todos los datos asociados en cualquier momento, desde la
extensión: abre el popup → Configuración (⚙) → "Eliminar cuenta y todos los datos
sincronizados". Esto borra inmediata y permanentemente tu registro de usuario y cada
blob cifrado ligado a tu cuenta del servidor (vía `DELETE /api/auth/account`) — no se
puede deshacer, y tampoco hay forma de que el administrador lo recupere después.

## Sin garantías

Este es un proyecto personal de mejor esfuerzo, no un servicio comercial:

- No hay un SLA. El servidor puede caerse por mantenimiento, un corte de luz en el
  homelab, un problema del ISP, o cualquier otra razón, sin previo aviso.
- No hay una línea de soporte dedicada — esto es un servicio administrado de forma
  informal, no un producto alojado con un equipo de soporte detrás.

## Por cuánto tiempo va a funcionar esto, y a quién contactar

- **Duración planeada:** _[admin: completar, ej. "al menos hasta 2027" — establece
  expectativas para que la gente no lo trate como infraestructura permanente]_
- **Dudas o inquietudes:** _[admin: completar tu contacto — email, usuario de
  Matrix/Discord, etc.]_
