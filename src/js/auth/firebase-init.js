// Inicialización consolidada de Firebase
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// Inicializar Firebase una sola vez
if (!window.firebaseApp) {
    window.firebaseApp = initializeApp(window.FIREBASE_CONFIG);
    window.firebaseAuth = getAuth(window.firebaseApp);
    window.firebaseDb = getFirestore(window.firebaseApp);
    console.log('✅ Firebase inicializado correctamente');
}
