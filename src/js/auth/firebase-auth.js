// Firebase Authentication Module
// Este módulo maneja toda la lógica de autenticación con Firebase

import { 
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut,
    onAuthStateChanged,
    sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

import { 
    collection,
    addDoc,
    getDocs,
    getDoc,
    query,
    where,
    orderBy,
    deleteDoc,
    doc,
    updateDoc,
    Timestamp
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// Exportar db y firestore para uso en otros módulos
export const db = () => window.firebaseDb;
export const firestore = {
    collection,
    addDoc,
    getDocs,
    getDoc,
    query,
    where,
    orderBy,
    deleteDoc,
    doc,
    updateDoc,
    Timestamp
};

// Estado global de autenticación
let currentUser = null;
let onAuthChangeCallback = null;

// Inicializar listener de cambios de autenticación
export function initAuth(callback) {
    onAuthChangeCallback = callback;
    
    onAuthStateChanged(window.firebaseAuth, (user) => {
        if (user) {
            currentUser = {
                uid: user.uid,
                email: user.email,
                username: user.email.split('@')[0],
                name: user.displayName || user.email.split('@')[0]
            };
            console.log('Usuario autenticado:', currentUser);
        } else {
            currentUser = null;
            console.log('Usuario no autenticado');
        }
        
        if (onAuthChangeCallback) {
            onAuthChangeCallback(currentUser);
        }
    });
}

// Login con email y contraseña
export async function login(email, password) {
    try {
        const userCredential = await signInWithEmailAndPassword(
            window.firebaseAuth, 
            email, 
            password
        );
        
        currentUser = {
            uid: userCredential.user.uid,
            email: userCredential.user.email,
            username: userCredential.user.email.split('@')[0],
            name: userCredential.user.displayName || userCredential.user.email.split('@')[0]
        };
        
        return { success: true, user: currentUser };
    } catch (error) {
        console.error('Error en login:', error);
        
        let message = 'Error al iniciar sesión';
        if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
            message = 'Email o contraseña incorrectos';
        } else if (error.code === 'auth/user-not-found') {
            message = 'Usuario no encontrado';
        } else if (error.code === 'auth/invalid-email') {
            message = 'Email inválido';
        } else if (error.code === 'auth/too-many-requests') {
            message = 'Demasiados intentos. Intenta más tarde';
        }
        
        return { success: false, error: message };
    }
}

// Registro de nuevo usuario
export async function register(email, password) {
    try {
        const userCredential = await createUserWithEmailAndPassword(
            window.firebaseAuth,
            email,
            password
        );
        
        currentUser = {
            uid: userCredential.user.uid,
            email: userCredential.user.email,
            username: userCredential.user.email.split('@')[0],
            name: userCredential.user.email.split('@')[0]
        };
        
        return { success: true, user: currentUser };
    } catch (error) {
        console.error('Error en registro:', error);
        
        let message = 'Error al crear cuenta';
        if (error.code === 'auth/email-already-in-use') {
            message = 'Este email ya está registrado';
        } else if (error.code === 'auth/invalid-email') {
            message = 'Email inválido';
        } else if (error.code === 'auth/weak-password') {
            message = 'La contraseña debe tener al menos 6 caracteres';
        }
        
        return { success: false, error: message };
    }
}

// Logout
export async function logout() {
    try {
        await signOut(window.firebaseAuth);
        currentUser = null;
        return { success: true };
    } catch (error) {
        console.error('Error en logout:', error);
        return { success: false, error: 'Error al cerrar sesión' };
    }
}

// Recuperar contraseña
export async function resetPassword(email) {
    try {
        await sendPasswordResetEmail(window.firebaseAuth, email);
        return { success: true };
    } catch (error) {
        console.error('Error al enviar email:', error);
        
        let message = 'Error al enviar email';
        if (error.code === 'auth/user-not-found') {
            message = 'Usuario no encontrado';
        } else if (error.code === 'auth/invalid-email') {
            message = 'Email inválido';
        }
        
        return { success: false, error: message };
    }
}

// Obtener usuario actual
export function getCurrentUser() {
    return currentUser;
}

// Verificar si está autenticado
export function isAuthenticated() {
    return currentUser !== null;
}
