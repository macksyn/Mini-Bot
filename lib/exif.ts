import { Sticker, StickerTypes } from 'stickers-formatter';
import path from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';
import fs from 'fs';

interface StickerMetadata {
    packname: string;
    author: string;
    categories?: string[];
}

interface MediaInput {
    mimetype: string;
    data: Buffer;
}

function randomFileName(): string {
    return path.join(tmpdir(), `${crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`);
}

export async function imageToWebp(media: Buffer): Promise<Buffer> {
    return await new Sticker(media, { type: StickerTypes.DEFAULT }).toBuffer();
}

export async function videoToWebp(media: Buffer): Promise<Buffer> {
    return await new Sticker(media, { type: StickerTypes.DEFAULT }).toBuffer();
}

export async function writeExifImg(media: Buffer, metadata: StickerMetadata): Promise<string> {
    const buff = await new Sticker(media, {
        pack: metadata.packname,
        author: metadata.author,
        categories: (metadata.categories || ['']) as any,
        type: StickerTypes.DEFAULT
    }).toBuffer();

    const tmpFileOut = randomFileName();
    fs.writeFileSync(tmpFileOut, buff);
    return tmpFileOut;
}

export async function writeExifVid(media: Buffer, metadata: StickerMetadata): Promise<string> {
    const buff = await new Sticker(media, {
        pack: metadata.packname,
        author: metadata.author,
        categories: (metadata.categories || ['']) as any,
        type: StickerTypes.DEFAULT
    }).toBuffer();

    const tmpFileOut = randomFileName();
    fs.writeFileSync(tmpFileOut, buff);
    return tmpFileOut;
}

export async function writeExif(media: MediaInput, metadata: StickerMetadata): Promise<string | null> {
    const input = /webp|image|video/.test(media.mimetype) ? media.data : null;
    if (!input) return null;

    const buff = await new Sticker(input, {
        pack: metadata.packname,
        author: metadata.author,
        categories: (metadata.categories || ['']) as any,
        type: StickerTypes.DEFAULT
    }).toBuffer();

    const tmpFileOut = randomFileName();
    fs.writeFileSync(tmpFileOut, buff);
    return tmpFileOut;
}
