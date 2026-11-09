import 'dotenv/config';

const _prefixes = process.env.PREFIXES ? process.env.PREFIXES.split(',') : ['.', '!', '/', '#'];

const config = {
    // Bot Identity
    botName:     process.env.BOT_NAME      || 'GROQ-AI',
    botOwner:    process.env.BOT_OWNER     || 'Alex Macksyn',
    ownerNumber: process.env.OWNER_NUMBER  || '2348089782988',
    author:      process.env.AUTHOR        || 'Alex Macksyn',
    packname:    process.env.PACKNAME      || 'GROQ-AI',
    description: process.env.DESCRIPTION  || 'High performance multi-device WhatsApp bot',
    version:     '6.0.1',

    // Bot Config
    prefixes:    _prefixes,
    prefix:      _prefixes[0],
    commandMode: process.env.COMMAND_MODE  || 'private',
    timeZone:    process.env.TIMEZONE      || 'Africa/Lagos',

    // Links
    channelLink:   process.env.CHANNEL_LINK || 'https://whatsapp.com/channel/0029Vad8fY6HwXbB83yLIx2n',
    updateZipUrl:  process.env.UPDATE_URL   || 'https://github.com/macksyn/MEGA-MDX/archive/refs/heads/main.zip',
    ytChannel:     process.env.YT_CHANNEL   || 'Macksyn',

    // Session
    sessionId:     process.env.SESSION_ID      || '',
    pairingNumber: process.env.PAIRING_NUMBER  || '',

    // Performance
    port:                Number(process.env.PORT)                 || 5000,
    maxStoreMessages:    Number(process.env.MAX_STORE_MESSAGES)   || 20,
    tempCleanupInterval: Number(process.env.CLEANUP_INTERVAL)     || 1 * 60 * 60 * 1000,
    storeWriteInterval:  Number(process.env.STORE_WRITE_INTERVAL) || 10000,

    // API Keys
    giphyApiKey: process.env.GIPHY_API_KEY || 'qnl7ssQChTdPjsKta2Ax2LMaGXz303tq',
    removeBgKey: process.env.REMOVEBG_KEY  || '',

    // Warn system
    warnCount: 3,

    // External APIs
    APIs: {
        xteam:    'https://api.xteam.xyz',
        dzx:      'https://api.dhamzxploit.my.id',
        lol:      'https://api.lolhuman.xyz',
        violetics:'https://violetics.pw',
        neoxr:    'https://api.neoxr.my.id',
        zenzapis: 'https://zenzapis.xyz',
        akuari:   'https://api.akuari.my.id',
        akuari2:  'https://apimu.my.id',
        nrtm:     'https://fg-nrtm.ddns.net',
        fgmods:   'https://api-fgmods.ddns.net'
    },

    APIKeys: {
        'https://api.xteam.xyz':       'd90a9e986e18778b',
        'https://api.lolhuman.xyz':    '85faf717d0545d14074659ad',
        'https://api.neoxr.my.id':     process.env.NEOXR_KEY   || 'yourkey',
        'https://violetics.pw':        'beta',
        'https://zenzapis.xyz':        process.env.ZENZAPIS_KEY || 'yourkey',
        'https://api-fgmods.ddns.net': 'fg-dylux'
    }
};

export default config;
