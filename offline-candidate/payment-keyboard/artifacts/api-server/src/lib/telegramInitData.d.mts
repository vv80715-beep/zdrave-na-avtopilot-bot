export function validateTelegramInitData(
  rawInitData: string,
  botToken: string,
  options?: { nowSeconds?: number; maxAgeSeconds?: number; futureSkewSeconds?: number },
): {
  telegramUserId: string;
  authDate: number;
  queryId: string | null;
};
