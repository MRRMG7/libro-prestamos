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

## Importante: los datos son locales al navegador

Esta app **no tiene servidor ni base de datos**: todo se guarda en el navegador del celular o computadora donde se use (localStorage). Esto significa:

- Si vos registrás un pago desde tu celular, **no aparece automáticamente** en el celular de otro familiar.
- Para compartir la información actualizada entre varios dispositivos, usá la pestaña **Datos**:
  - **Exportar datos** genera un archivo `.json` con todo (clientes, préstamos, pagos).
  - Ese archivo se lo pasás a la otra persona (WhatsApp, correo, etc.) y ella lo carga con **Importar datos** en su celular.
- Si en el futuro quieren que todos vean lo mismo en tiempo real sin pasarse archivos, se necesitaría agregar una base de datos en la nube (por ejemplo Firebase). Puedo ayudarte a agregar eso después si te interesa.

## Estructura de archivos

```
index.html        página principal
css/style.css      estilos
js/app.js          toda la lógica (clientes, préstamos, pagos, calculadora)
```
