# JowAdmin - Panel de Administración para Discord

Panel administrativo para gestionar una comunidad de Discord, con sistema de puntos, rangos, cargos y apelaciones.


## Características Actuales

- ✅ **Frontend completo**: Interfaz de usuario limpia y responsive
- ✅ **Navegación por pestañas**: Resumen, Staff, Puntos, Rangos, Guía, Apelaciones, Novedades, Administración
- ✅ **Estructura de backend preparada**: Node.js + Express + SQLite
- ✅ **Colores de rangos personalizados**: Owner (Rojo), Admin (Verde), Tester (#11806A)


## Cómo Ejecutar

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar variables de entorno

Copia el archivo `.env.example` a `.env` y modifica los valores según tus necesidades:

```bash
cp .env.example .env
```

### 3. Iniciar el servidor

```bash
# Modo desarrollo (con nodemon)
npm run dev

# Modo producción
npm start
```

El servidor estará disponible en `http://localhost:3000`


## Estructura del Proyecto

```
JowAdmin/
├── backend/
│   ├── database/
│   │   └── db.js          # Configuración y creación de tablas SQLite
│   └── server.js          # Servidor Express principal
├── .history/              # Historial de cambios (ignorado por Git)
├── .env.example           # Ejemplo de variables de entorno
├── .gitignore             # Archivos ignorados por Git
├── index.html             # Página principal
├── script.js              # Lógica del frontend
├── style.css              # Estilos
└── package.json           # Dependencias del proyecto
```


## Funcionalidades Pendientes (Requieren Backend)

- 🔐 **Autenticación**: Inicio de sesión con Discord OAuth2 o credenciales
- 📊 **Base de datos**: Almacenamiento real de usuarios, puntos, etc.
- 🤖 **Bot de Discord**: Sincronización automática de datos
- ⚙️ **CRUD completo**: Crear, editar, eliminar usuarios desde el panel
- 📝 **Historial de auditoría**: Registro de cambios en puntos y usuarios

## Firebase

El panel ahora usa Firebase Auth y Firestore para el registro y el inicio de sesión.

- Habilita `Email/Password` en Firebase Authentication
- Crea Firestore en el proyecto `jowiland-2`
- La colección de perfiles usa `profiles/{uid}` y guarda `username`, `email` y `accountRole`
- Si querés probar rápido, estas reglas dejan escribir/leer solo al usuario autenticado sobre su propio perfil:

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /profiles/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## Deploy

Antes de publicar en Firebase Hosting:

```bash
firebase deploy
```

O con un solo comando:

```bash
npm run deploy
```


## Notas Importantes

- **Frontend en GitHub Pages**: El frontend funciona en GitHub Pages, pero las funcionalidades de backend no estarán disponibles hasta que se despliegue el servidor.
- **Seguridad**: Nunca compartas tu archivo `.env` o tokens de Discord.
- **Datos estáticos**: Actualmente el frontend usa datos vacíos preparados para ser alimentados por el backend.


## Contribuciones

¡Las contribuciones son bienvenidas! Si tienes ideas para mejorar el proyecto, no dudes en abrir un issue o un pull request.
