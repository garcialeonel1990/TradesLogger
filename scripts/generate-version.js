#!/usr/bin/env node
/**
 * Script para generar el archivo version.json con la información del último push
 * Se ejecuta como parte del build de Vercel
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function formatSpanishDate(isoString) {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return null;

    // Forzar formato en zona horaria de Argentina para evitar diferencias por runtime.
    const formatter = new Intl.DateTimeFormat('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const parts = formatter.formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value;

    const day = get('day');
    const month = get('month');
    const year = get('year');
    const hour = get('hour');
    const minute = get('minute');
    const second = get('second');

    if (!day || !month || !year || !hour || !minute || !second) return null;

    return `${day} de ${month} de ${year} - ${hour}:${minute}:${second}`;
}

try {
    // Priorizar variables de entorno de Vercel y luego fallback a git local
    let lastPushIso = process.env.VERCEL_GIT_COMMIT_TIMESTAMP || process.env.CI_COMMIT_TIMESTAMP;
    let commitHash = process.env.VERCEL_GIT_COMMIT_SHA || process.env.CI_COMMIT_SHA;

    if (!lastPushIso) {
        lastPushIso = execSync('git log -1 --format=%aI').toString().trim();
    }

    if (!commitHash) {
        commitHash = execSync('git log -1 --format=%H').toString().trim();
    }

    const formatted = formatSpanishDate(lastPushIso);
    const commitShort = (commitHash || 'unknown').substring(0, 7);
    
    const versionData = {
        lastPush: lastPushIso,
        lastPushFormatted: formatted || 'Fecha no disponible',
        commitHash: commitHash || 'unknown',
        commitShort: commitShort,
        timestamp: Date.now()
    };
    
    // Escribir el archivo usando el directorio de trabajo actual (raíz del proyecto)
    const outputPath = path.join(process.cwd(), 'src/config/version.json');
    
    // Crear directorio si no existe
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(outputPath, JSON.stringify(versionData, null, 2));
    
    console.log(`✅ version.json actualizado: ${versionData.lastPushFormatted} (${commitShort})`);
} catch (error) {
    console.error('❌ Error generando version.json:', error.message);
    // No fallar el build, solo advertencia
    
    // Crear un archivo default
    const defaultVersion = {
        lastPush: new Date().toISOString(),
        lastPushFormatted: formatSpanishDate(new Date().toISOString()) || 'Fecha no disponible',
        commitHash: 'unknown',
        commitShort: 'unknown',
        timestamp: Date.now()
    };
    
    const outputPath = path.join(process.cwd(), 'src/config/version.json');
    
    // Crear directorio si no existe
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(outputPath, JSON.stringify(defaultVersion, null, 2));
    console.log('⚠️ version.json creado con valores default');
}
