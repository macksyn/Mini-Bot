
// @ts-nocheck
/***
 * lib/marketUi.ts
 *
 * Button-driven black market and member inventory.
 *
 * Navigation:
 *   home -> protection | gear | ammoShop | inventory
 *   protection / gear -> confirm -> previous catalog
 *   ammoShop -> ammoTarget -> buy pack for selected gun
 *   inventory -> equip gun | ammoShop | market
 *
 * Back and Cancel are appended by the shared navigation router.
 */
import type { Screen, ScreenView, Nav } from './bankUi.js';
import { formatNumber, getWallet } from './economy.js';

import {
  ITEMS,
  AMMO_PACKS,
  MARKET_CONFIG,
  listItems,
  listAmmoPacks,
  getInventory,
  getGunAmmo,
  activeProtection,
  hasMask,
  buyItem,
  buyAmmoPack,
  equipGun,
  fmtDuration,
  lifeBar,
  type ShopItem,
} from './market.js';

const fmt = formatNumber;
const RULE = '━━━━━━━━━━━━━━';
const pct = (n: number) => `${Math.round(n * 100)}%`;
const days = (ms: number) => `${Math.round(ms / 86_400_000)}d`;

function shortInfo(i: ShopItem): string {
  if (i.kind === 'protection') {
    return `${days(i.durationMs!)} · ${i.life} HP`;
  }

  if (i.kind === 'mask') {
    return `${pct(i.successRate!)} success · ${days(i.durationMs!)}`;
  }

  return `${i.rounds} magazine · ${i.damage} dmg`;
}

function longInfo(i: ShopItem): string {
  if (i.kind === 'protection') {
    return `Protects you for *${days(i.durationMs!)}*. Robbery attempts drain its life bar (*${i.life} HP*). If the protection breaks or expires, future attacks can reach your wallet.`;
  }

  if (i.kind === 'mask') {
    return `Raises robbery success from *${pct(MARKET_CONFIG.BASE_SUCCESS)}* to *${pct(i.successRate!)}* for *${days(i.durationMs!)}*. Buying again extends the duration.`;
  }

  return [
    `Magazine capacity: *${i.rounds} rounds*`,
    `Starting reserve: *${i.startingReserveAmmo ?? 0} rounds*`,
    `Reload time: *${fmtDuration(i.reloadMs ?? MARKET_CONFIG.RELOAD_MS)}*`,
    `Protection damage: *${i.damage} HP per shot*`,
    '',
    'One round is consumed per actual robbery attempt.',
    'Reloading uses reserve ammunition. Buy ammo packs when your supply runs low.',
    'The gun is yours to keep.',
  ].join('\n');
}

async function walletLine(userId: string): Promise<string> {
  return `Wallet: ${fmt((await getWallet(userId)).coins)} coins`;
}

function gunLabel(gunId: string): string {
  const gun = ITEMS[gunId];
  return `${gun.emoji} ${gun.name}`;
}

// ── Home ─────────────────────────────────────────────────────────────────

const home: Screen = {
  async view(ctx): Promise<ScreenView> {
    const now = Date.now();
    const inv = await getInventory(ctx.userId);
    const prot = activeProtection(inv, now);

    const status = [
      prot
        ? `🛡️ ${ITEMS[prot.itemId]?.name ?? 'Protection'} · ${fmtDuration(prot.expiresAt - now)} left`
        : '🛡️ Unprotected',
      hasMask(inv, now)
        ? `🎭 Masked · ${fmtDuration(inv.maskUntil - now)} left`
        : null,
      inv.equippedGun
        ? `🔫 Equipped: ${ITEMS[inv.equippedGun]?.name ?? inv.equippedGun}`
        : '🔫 No gun equipped',
    ].filter(Boolean).join('\n');

    return {
      title: '🛒 BLACK MARKET',
      subtitle: await walletLine(ctx.userId),
      text: `${status}\n${RULE}\nWhat are you shopping for?`,
      options: [
        {
          label: '🛡️ Rob Protection',
          value: 'protection',
          description: 'Bodyguards & escorts',
        },
        {
          label: '🎭 Rob Gear',
          value: 'gear',
          description: 'Masks & guns',
        },
        {
          label: '📦 Ammo Shop',
          value: 'ammoShop',
          description: 'Buy ammunition for your guns',
        },
        {
          label: '🎒 My Inventory',
          value: 'inventory',
          description: 'Weapons, ammo & protection',
        },
      ],
    };
  },

  async select(value): Promise<Nav> {
    return { go: value };
  },
};

// ── Item catalogs ────────────────────────────────────────────────────────

function catalog(
  title: string,
  text: string,
  ...kinds: ShopItem['kind'][]
): Screen {
  return {
    async view(ctx): Promise<ScreenView> {
      return {
        title,
        subtitle: await walletLine(ctx.userId),
        text,
        options: listItems(...kinds).map(item => ({
          label: `${item.emoji} ${item.name} · ${fmt(item.price)}`,
          value: item.id,
          description: shortInfo(item),
        })),
      };
    },

    async select(value): Promise<Nav> {
      return {
        go: 'confirm',
        params: { itemId: value },
      };
    },
  };
}

const protection = catalog(
  '🛡️ PROTECTION',
  'Hire protection against robbers. Higher tiers last longer and take more hits.',
  'protection',
);

const gear = catalog(
  '🎭 ROB GEAR',
  `Masks improve your success chance. Guns deal damage to protection and have finite ammunition.\n\nBase success: ${pct(MARKET_CONFIG.BASE_SUCCESS)}\nNo-gun cooldown: ${fmtDuration(MARKET_CONFIG.NO_GUN_COOLDOWN_MS)}\n\nBuy ammunition separately in the Ammo Shop.`,
  'mask',
  'gun',
);

// ── Confirm and purchase items ────────────────────────────────────────────

const confirm: Screen = {
  async view(ctx, params): Promise<ScreenView> {
    const item = ITEMS[params?.itemId];

    if (!item) {
      throw new Error(`unknown market item "${params?.itemId}"`);
    }

    return {
      title: `${item.emoji} ${item.name}`.slice(0, 24),
      subtitle: await walletLine(ctx.userId),
      text: `${longInfo(item)}\n${RULE}\nPrice: *${fmt(item.price)} coins*`,
      options: [
        {
          label: `✅ Buy for ${fmt(item.price)}`,
          value: 'buy',
        },
      ],
    };
  },

  async select(value, ctx, params): Promise<Nav> {
    if (value !== 'buy') {
      return { back: true };
    }

    const r = await buyItem(ctx.userId, params.itemId);

    if (r.ok) {
      const extra = r.item.kind === 'gun'
        ? `\nLoaded: *${r.item.rounds} rounds*. Reserve: *${r.item.startingReserveAmmo ?? 0} rounds*.\nUse *Ammo Shop* to buy more ammunition.`
        : '';

      return {
        back: true,
        notice:
          `✅ Bought ${r.item.emoji} *${r.item.name}* for ` +
          `${fmt(r.item.price)} coins. Balance: *${fmt(r.coinsLeft)}*` +
          extra,
      };
    }

    switch (r.reason) {
      case 'insufficient_funds':
        return {
          back: true,
          notice: `❌ Not enough coins — you have *${fmt(r.coins)}*.`,
        };

      case 'already_protected':
        return {
          back: true,
          notice:
            `❌ You're already protected by *${ITEMS[r.current.itemId]?.name ?? 'Protection'}* ` +
            `(${fmtDuration(r.current.expiresAt - Date.now())} left).`,
        };

      case 'already_owned':
        return {
          back: true,
          notice: `❌ You already own *${ITEMS[params.itemId]?.name ?? params.itemId}*.`,
        };

      default:
        return {
          back: true,
          notice: `⚠️ Couldn't complete that purchase. Check your balance and try again.`,
        };
    }
  },
};

// ── Ammunition shop ──────────────────────────────────────────────────────

const ammoShop: Screen = {
  async view(ctx): Promise<ScreenView> {
    const inv = await getInventory(ctx.userId);
    const packs = listAmmoPacks();

    const options = packs.map(pack => ({
      label: `${pack.emoji} ${pack.name} · ${fmt(pack.price)}`,
      value: pack.id,
      description: `${pack.rounds} rounds · ${fmt(pack.price)} coins`,
    }));

    if (inv.guns.length === 0) {
      return {
        title: '📦 AMMO SHOP',
        subtitle: await walletLine(ctx.userId),
        text:
          `You don't own a gun yet.\n` +
          `Buy a gun from Rob Gear before purchasing ammunition.\n` +
          `${RULE}\n` +
          `Ammunition packs add rounds to a weapon's reserve. Reloading consumes reserve rounds.`,
        options: [
          {
            label: '🎭 Browse Guns',
            value: 'gear',
            description: 'Buy your first weapon',
          },
        ],
      };
    }

    return {
      title: '📦 AMMO SHOP',
      subtitle: await walletLine(ctx.userId),
      text: [
        'Choose an ammunition pack.',
        '',
        'Small: 5 rounds',
        'Medium: 15 rounds',
        'Large: 30 rounds',
        RULE,
        'Next, select which owned gun receives the ammunition.',
        'Packs add to reserve ammo, not directly to the magazine.',
      ].join('\n'),
      options,
    };
  },

  async select(value): Promise<Nav> {
    if (value === 'gear') {
      return { go: 'gear' };
    }

    if (!AMMO_PACKS[value]) {
      return { stay: true, notice: '❌ That ammunition pack is unavailable.' };
    }

    return {
      go: 'ammoTarget',
      params: { packId: value },
    };
  },
};

// ── Select the gun that receives a pack ───────────────────────────────────

const ammoTarget: Screen = {
  async view(ctx, params): Promise<ScreenView> {
    const pack = AMMO_PACKS[params?.packId];

    if (!pack) {
      return {
        title: '📦 AMMO SHOP',
        subtitle: await walletLine(ctx.userId),
        text: 'That ammunition pack could not be found.',
        options: [
          {
            label: '📦 Back to Ammo Shop',
            value: 'ammoShop',
            description: 'Choose another pack',
          },
        ],
      };
    }

    const inv = await getInventory(ctx.userId);

    if (inv.guns.length === 0) {
      return {
        title: '🔫 CHOOSE YOUR GUN',
        subtitle: await walletLine(ctx.userId),
        text: 'You no longer own a gun that can receive ammunition.',
        options: [
          {
            label: '🎭 Browse Guns',
            value: 'gear',
            description: 'Buy a gun first',
          },
        ],
      };
    }

    const options = inv.guns.map(gunId => {
      const gun = ITEMS[gunId];
      const ammo = getGunAmmo(inv, gunId)!;

      return {
        label: `${gun.emoji} ${gun.name}`,
        value: `buy:${gunId}`,
        description:
          `${ammo.magazineAmmo}/${gun.rounds} loaded · ` +
          `${ammo.reserveAmmo} reserve`,
      };
    });

    return {
      title: '🔫 CHOOSE YOUR GUN',
      subtitle: await walletLine(ctx.userId),
      text:
        `Pack: *${pack.name}*\n` +
        `Rounds added: *${pack.rounds}*\n` +
        `Price: *${fmt(pack.price)} coins*\n` +
        `${RULE}\n` +
        'Which gun should receive this pack?',
      options,
    };
  },

  async select(value, ctx, params): Promise<Nav> {
    if (value === 'ammoShop') {
      return { go: 'ammoShop' };
    }

    if (value === 'gear') {
      return { go: 'gear' };
    }

    if (!value.startsWith('buy:')) {
      return { back: true };
    }

    const gunId = value.slice(4);
    const packId = params?.packId;

    const result = await buyAmmoPack(
      ctx.userId,
      packId,
      gunId,
    );

    if (result.ok) {
      return {
        back: true,
        notice:
          `✅ Bought *${result.pack.name}* for ${result.gun.name}.\n` +
          `Added: *${result.roundsAdded} rounds* to reserve.\n` +
          `Reserve now: *${result.reserveAmmo} rounds*.\n` +
          `Balance: *${fmt(result.coinsLeft)} coins*.`,
      };
    }

    switch (result.reason) {
      case 'unknown_pack':
        return {
          back: true,
          notice: '❌ That ammunition pack is unavailable.',
        };

      case 'no_gun':
      case 'gun_not_owned':
        return {
          back: true,
          notice: '❌ You must own the selected gun before buying its ammunition.',
        };

      case 'insufficient_funds':
        return {
          back: true,
          notice: `❌ Not enough coins — you have *${fmt(result.coins)}*.`,
        };

      default:
        return {
          back: true,
          notice: '⚠️ Ammunition could not be delivered. Please check your inventory and try again.',
        };
    }
  },
};

// ── Inventory ────────────────────────────────────────────────────────────

function inventory(withMarketLink: boolean): Screen {
  return {
    async view(ctx): Promise<ScreenView> {
      const now = Date.now();
      const inv = await getInventory(ctx.userId);
      const prot = activeProtection(inv, now);
      const lines: string[] = [];

      if (prot) {
        const def = ITEMS[prot.itemId];

        lines.push(
          `🛡️ *${def?.name ?? 'Protection'}* · ` +
          `${fmtDuration(prot.expiresAt - now)} left`,
        );
        lines.push(
          `❤️ ${lifeBar(prot.life, prot.maxLife)} ` +
          `${prot.life}/${prot.maxLife} HP`,
        );
      } else {
        lines.push('🛡️ No protection — you can be robbed.');
      }

      lines.push(
        hasMask(inv, now)
          ? `🎭 *Mask* · ${fmtDuration(inv.maskUntil - now)} left`
          : '🎭 No mask',
      );

      if (inv.guns.length > 0) {
        lines.push('', '*Guns & Ammunition*');

        for (const id of inv.guns) {
          const gun = ITEMS[id];
          const ammo = getGunAmmo(inv, id)!;
          const equipped = id === inv.equippedGun;
          const reloading = ammo.reloadUntil > now;

          lines.push(
            `${gun.emoji} *${gun.name}*${equipped ? ' ✅ equipped' : ''}`,
          );
          lines.push(
            `   🔸 Loaded: ${ammo.magazineAmmo}/${gun.rounds}`,
          );
          lines.push(
            `   📦 Reserve: ${ammo.reserveAmmo} rounds`,
          );
          lines.push(
            `   💥 Protection damage: ${gun.damage}`,
          );

          if (reloading) {
            lines.push(
              `   ⏳ Reloading: ${fmtDuration(ammo.reloadUntil - now)}`,
            );
          } else if (ammo.magazineAmmo === 0 && ammo.reserveAmmo === 0) {
            lines.push('   ❌ Empty — buy ammunition');
          } else if (ammo.magazineAmmo === 0 && ammo.reserveAmmo > 0) {
            lines.push('   🔄 Reload pending on next robbery attempt');
          }
        }
      } else {
        lines.push('', '🔫 No gun — browse Rob Gear to buy one.');
      }

      const gun = inv.equippedGun
        ? ITEMS[inv.equippedGun]
        : null;

      const equippedAmmo = inv.equippedGun
        ? getGunAmmo(inv, inv.equippedGun)
        : null;

      if (inv.cooldownUntil > now) {
        lines.push(
          '',
          `⏳ ${gun ? 'Reloading / cooldown' : 'Laying low'}: ` +
          `${fmtDuration(inv.cooldownUntil - now)}`,
        );
      } else if (gun && equippedAmmo) {
        if (equippedAmmo.magazineAmmo > 0) {
          lines.push(
            '',
            `✅ Ready: ${equippedAmmo.magazineAmmo}/${gun.rounds} loaded · ` +
            `${equippedAmmo.reserveAmmo} reserve`,
          );
        } else if (equippedAmmo.reserveAmmo > 0) {
          lines.push(
            '',
            '🔄 Magazine empty — next robbery attempt starts the reload.',
          );
        } else {
          lines.push('', '❌ Out of ammunition — visit the Ammo Shop.');
        }
      } else {
        lines.push('', '✅ Ready to rob (no gun equipped).');
      }

      const options: any[] = inv.guns
        .filter(id => id !== inv.equippedGun)
        .map(id => {
          const gunDef = ITEMS[id];
          const ammo = getGunAmmo(inv, id)!;

          return {
            label: `${gunDef.emoji} Equip ${gunDef.name}`,
            value: `equip:${id}`,
            description:
              `${ammo.magazineAmmo}/${gunDef.rounds} loaded · ` +
              `${ammo.reserveAmmo} reserve`,
          };
        });

      if (inv.guns.length > 0) {
        options.push({
          label: '📦 Buy Ammunition',
          value: 'ammoShop',
          description: 'Purchase reserve rounds',
        });
      }

      if (withMarketLink) {
        options.push({
          label: '🛒 Open Market',
          value: 'market',
          description: 'Buy protection, guns & gear',
        });
      }

      return {
        title: '🎒 INVENTORY',
        subtitle: await walletLine(ctx.userId),
        text: lines.join('\n'),
        options,
      };
    },

    async select(value, ctx): Promise<Nav> {
      if (value === 'market') {
        return { go: 'home' };
      }

      if (value === 'ammoShop') {
        return { go: 'ammoShop' };
      }

      if (value.startsWith('equip:')) {
        const r = await equipGun(ctx.userId, value.slice(6));

        return r.ok
          ? {
              stay: true,
              notice:
                `✅ Equipped ${r.gun!.emoji} *${r.gun!.name}*.\n` +
                'Each weapon keeps its own ammunition and reload state.',
            }
          : {
              stay: true,
              notice: `❌ You don't own that gun.`,
            };
      }

      return { stay: true };
    },
  };
}

// ── Router exports ───────────────────────────────────────────────────────

export const MARKET_SCREENS: Record<string, Screen> = {
  home,
  protection,
  gear,
  confirm,
  ammoShop,
  ammoTarget,
  inventory: inventory(false),
  inventoryRoot: inventory(true),
};
