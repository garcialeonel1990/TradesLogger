function formatVersionDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const formatted = d.toLocaleString('es-AR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'America/Argentina/Buenos_Aires'
    });
    return formatted;
}

async function loadVersionInfo() {
    const versionText = document.getElementById('versionText');
    if (!versionText) return;

    try {
        const response = await fetch('src/config/version.json');
        if (response.ok) {
            const versionData = await response.json();
            const fallbackDate = formatVersionDate(versionData.lastPush);
            const etiqueta = versionData.lastPushFormatted || fallbackDate;
            const commit = versionData.commitShort && versionData.commitShort !== 'unknown'
                ? ` · ${versionData.commitShort}`
                : '';

            if (etiqueta) {
                versionText.textContent = `📦 Última actualización: ${etiqueta}${commit}`;
            } else {
                versionText.textContent = '📦 Versión local';
            }
        } else {
            versionText.textContent = '📦 Versión local';
        }
    } catch (error) {
        versionText.textContent = '📦 Versión local';
    }
}

// Cargar versión cuando el DOM esté listo
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadVersionInfo);
} else {
    loadVersionInfo();
}
