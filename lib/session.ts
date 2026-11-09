import path from 'path';
import fs from 'fs';
import { File } from 'megajs';
import { printLog } from './print.js';

/**
 * Save credentials from Mega to session/creds.json
 * @param {string} txt - Mega file ID (with or without full URL)
 */
async function SaveCreds(txt: string): Promise<void> {
    if (!txt || !txt.trim()) {
        throw new Error('SESSION_ID is empty');
    }

    let megaId = txt.trim();

    // Strip full URL if provided: https://mega.nz/file/ABC123#KEY
    if (megaId.includes('mega.nz/file/')) {
        megaId = megaId.split('mega.nz/file/')[1];
    }

    // Strip any legacy prefix from old format
    megaId = megaId.replace('GlobalTechInfo/MEGA-MD_', '').trim();

    const megaUrl = `https://mega.nz/file/${megaId}`;
    printLog('info', `📥 Downloading session from Mega: ${megaUrl}`);

    try {
        const file = File.fromURL(megaUrl);
        await file.loadAttributes();
        const data = await file.downloadBuffer({});

        const sessionDir = path.join(process.cwd(), 'session');
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const credsPath = path.join(sessionDir, 'creds.json');
        fs.writeFileSync(credsPath, data);
        printLog('success', 'Session credentials downloaded from Mega successfully');
    } catch (error: any) {
        printLog('error', `Error downloading credentials from Mega: ${error.message}`);
        throw error;
    }
}

export default SaveCreds;
