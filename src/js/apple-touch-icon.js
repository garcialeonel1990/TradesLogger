// Generar icono PNG para iOS home screen
const canvas = document.createElement('canvas');
canvas.width = 180;
canvas.height = 180;
const ctx = canvas.getContext('2d');

// Fondo oscuro
ctx.fillStyle = '#1a1a1a';
ctx.fillRect(0, 0, 180, 180);

// Símbolo $
ctx.fillStyle = '#10b981';
ctx.font = 'bold 120px Arial';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillText('$', 90, 90);

// Convertir a PNG y establecer como icono
document.getElementById('appleTouchIcon').href = canvas.toDataURL('image/png');
