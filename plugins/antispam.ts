const groupCache = new Map<string, number>();

export async function handleAntiSpam(_sock: any, _chatId: string, _message: any): Promise<boolean> {
    return false;
}

export function invalidateGroupCache(groupId?: string): void {
    if (!groupId) return;
    groupCache.delete(groupId);
}

export function getGroupCacheSize(): number {
    return groupCache.size;
}
