/** Plano de contas do diário (D27.2). Cada conta existe por moeda. */
export enum AccountCode {
  /** Uma por wallet: o passivo da casa com o jogador. */
  PlayerWallet = "PLAYER_WALLET",
  HouseOpeningFunds = "HOUSE_OPENING_FUNDS",
  HouseWagersReceived = "HOUSE_WAGERS_RECEIVED",
  HousePayouts = "HOUSE_PAYOUTS",
  HouseRefunds = "HOUSE_REFUNDS",
  HouseRollbacks = "HOUSE_ROLLBACKS",
}

export enum AccountNature {
  Asset = "ASSET",
  Liability = "LIABILITY",
  Revenue = "REVENUE",
  ContraRevenue = "CONTRA_REVENUE",
  Expense = "EXPENSE",
  Adjustment = "ADJUSTMENT",
}

/** A natureza de cada conta; o banco confere o mesmo par (`accounts_nature_ck`, D27.3). */
export const ACCOUNT_NATURE: Readonly<Record<AccountCode, AccountNature>> = Object.freeze({
  [AccountCode.PlayerWallet]: AccountNature.Liability,
  [AccountCode.HouseOpeningFunds]: AccountNature.Asset,
  [AccountCode.HouseWagersReceived]: AccountNature.Revenue,
  [AccountCode.HousePayouts]: AccountNature.Expense,
  [AccountCode.HouseRefunds]: AccountNature.ContraRevenue,
  [AccountCode.HouseRollbacks]: AccountNature.Adjustment,
});
