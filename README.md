# Libro de Préstamos

Sistema web simple para llevar el control de préstamos familiares: capital, interés (8% o 10%), abonos parciales e historial de pagos. Incluye una calculadora rápida.

## Cómo funciona el interés

- Cada mes se cobra el **mes completo de interés**, sin importar el día en que se prestó el dinero (ej: si prestás el 19 de julio, para el corte de fin de mes se cobra el mes completo, no proporcional).
- El interés se calcula sobre el **capital que quede pendiente** en ese momento. Si abonan a capital, el próximo mes el interés ya se calcula sobre el saldo reducido.

## Cómo publicarlo en GitHub Pages (gratis)

1. Creá un repositorio nuevo en GitHub (puede ser privado si no querés que sea público).
2. Subí estos archivos tal cual (mantené las carpetas `css/` y `js/`).
3. En el repositorio: **Settings → Pages**.
4. En "Source" elegí la rama `main` y la carpeta `/root`, luego **Save**.
5. GitHub te da un link como `https://tu-usuario.github.io/tu-repo/` — ese es el que compartís con tu familia. Funciona bien desde el celular.

### Subida rápida por terminal

```bash
git init
git add .
git commit -m "Sistema de préstamos"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

Después activás Pages como en el paso 3.

## Los datos se sincronizan solos entre celulares (Firebase)

Esta app usa **Firebase Firestore** (plan gratuito, no pide tarjeta) como base de datos en la nube. Cualquier celular o computadora que abra el sitio ve los mismos clientes, préstamos y pagos, en tiempo real. Para que funcione, tenés que crear tu propio proyecto de Firebase (es tuyo, gratis, y solo tarda unos minutos) y pegar su configuración en el código.

### Paso a paso para conectar Firebase

1. Andá a [console.firebase.google.com](https://console.firebase.google.com) e iniciá sesión con una cuenta de Google.
2. **Add project / Crear proyecto** → ponele un nombre (ej. `libro-prestamos`) → seguí los pasos (podés desactivar Google Analytics, no hace falta) → **Crear proyecto**.
3. En el menú izquierdo: **Build → Firestore Database** → **Create database**.
   - Elegí una ubicación (cualquiera de EE.UU. o la más cercana está bien) → **Next**.
   - En "Rules", elegí **Start in production mode** → **Enable**.
4. Andá a la pestaña **Rules** dentro de Firestore Database y reemplazá el contenido por esto (permite que la app lea y escriba, ya que es de uso familiar sin login):

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if true;
       }
     }
   }
   ```
   Clic en **Publish**.

   ⚠️ Esto significa que cualquiera que tenga el link de tu sitio (o encuentre la configuración) podría, en teoría, ver o modificar los datos. Para un uso informal familiar está bien, pero no es apto para datos delicados. Si más adelante querés protegerlo con una contraseña de verdad, se puede agregar Firebase Authentication.

5. Volvé a la página principal del proyecto (ícono de casita) → clic en el ícono **</>** ("Web") para registrar una app web.
   - Ponele un apodo (ej. `libro-prestamos-web`) → **Registrar app**.
   - Te va a mostrar un bloque de código con un objeto `firebaseConfig = { apiKey: ..., authDomain: ..., ... }`. Copiá esos valores.
6. En tu repo de GitHub (o en Antigravity/Cursor), abrí el archivo **`js/firebase-config.js`** y reemplazá los valores de ejemplo por los tuyos, tal cual los copiaste. Guardá.
7. Subí el cambio a GitHub (commit + push). En 1-2 minutos, recargá tu sitio — arriba, junto al título, debería aparecer un punto verde con **"Conectado"**.

### Backup

Aunque ahora los datos viven en la nube, la pestaña **Datos → Exportar datos** sigue sirviendo como respaldo por si algún día alguien borra algo por error.

## Cerrar el acceso a quien no sea de la familia (login con contraseña)

Si ya le compartiste el link a alguien más (amigos, etc.) y ahora querés que **solo vos, mamá y papá** puedan entrar, hay que activar el login y cambiar las reglas de Firestore. Así, cualquiera sin la clave solo ve una pantalla de acceso, sin ver ni tocar ningún dato.

### 1. Activar el método de acceso en Firebase

1. En la consola de Firebase de tu proyecto → menú lateral → **Compilación → Authentication**.
2. **Comenzar / Get started**.
3. En la lista de proveedores, elegí **Correo electrónico/contraseña (Email/Password)** → activalo (el primer interruptor) → **Guardar**.

### 2. Crear la clave de acceso para la familia

1. Dentro de **Authentication**, pestaña **Users** → **Add user**.
2. Poné un correo (no hace falta que sea uno real que revisen, solo sirve como usuario — ej. `familia@libroprestamos.com`) y una contraseña que puedan recordar los 3 → **Add user**.
3. Esa misma clave se la compartís a vos, mamá y papá para entrar desde cualquier celular. (Si preferís que cada uno tenga su propia clave en vez de una compartida, repetís este paso creando un usuario más por persona.)

### 3. Cambiar las reglas de Firestore para exigir el login

1. **Compilación → Firestore Database → Rules**.
2. Reemplazá las reglas por estas (ahora exigen haber iniciado sesión):

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```
3. **Publish**.

Desde ese momento, cualquiera que abra el link (tus amigos incluidos) solo va a ver la pantalla de acceso pidiendo correo y contraseña, y sin la clave no pueden ver ni modificar nada. Vos, mamá y papá entran una vez con la clave desde cada celular y el navegador los mantiene conectados (no hay que volver a escribirla cada vez, salvo que le den a "Cerrar sesión" o borren los datos del navegador).

## Estructura de archivos

```
index.html        página principal
css/style.css      estilos
js/app.js          toda la lógica (clientes, préstamos, pagos, calculadora)
```
