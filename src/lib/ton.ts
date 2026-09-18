/**
 * Сообщение для перевода USDT в сети TON.
 *
 * Кошелёк подписывает готовое тело сообщения, и собрать его должен тот, кто
 * просит перевод. Библиотеки для этого весят под мегабайт, а нужна одна
 * ячейка без ссылок — она и собирается здесь руками по TEP-74 и описанию
 * формата BOC. Сборка сверена с эталонной реализацией (@ton/core) в
 * tools/ton-boc-check.mjs: тот же перевод, байт в байт.
 */

/**
 * Адрес — в человеческом виде (EQ… или UQ…) или в сыром (`0:…`).
 *
 * Сырой приходит от кошелька через TON Connect, человеческий — от нашего
 * сервера, и разбирать нужно оба: это один и тот же адрес в двух записях.
 */
export function parseAddr(addr: string): { wc: number; hash: Uint8Array } {
  const raw0 = String(addr || "").trim();
  if (raw0.includes(":")) {
    const [wcs, hex] = raw0.split(":");
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("ton: сырой адрес не 32 байта");
    const hash = new Uint8Array(32);
    for (let i = 0; i < 32; i++) hash[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return { wc: Number(wcs) | 0, hash };
  }
  const s = raw0.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s);
  if (raw.length !== 36) throw new Error("ton: адрес не 36 байт");
  const b = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  // Байт 0 — флаги (годен ли адрес для приёма, тестовая ли сеть), байт 1 —
  // рабочая цепочка со знаком, дальше 32 байта самого адреса и две байта суммы.
  return { wc: b[1]! > 127 ? b[1]! - 256 : b[1]!, hash: b.slice(2, 34) };
}

/** Складывает биты по одному: ячейка TON меряется битами, а не байтами. */
class Bits {
  private bytes: number[] = [];
  private len = 0;

  bit(v: number): this {
    if (this.len % 8 === 0) this.bytes.push(0);
    if (v) this.bytes[this.bytes.length - 1]! |= 0x80 >> (this.len % 8);
    this.len++;
    return this;
  }

  uint(value: bigint | number, width: number): this {
    const v = BigInt(value);
    for (let i = width - 1; i >= 0; i--) this.bit(Number((v >> BigInt(i)) & 1n));
    return this;
  }

  /** Деньги: сперва длина в байтах четырьмя битами, следом сами байты. */
  coins(value: bigint): this {
    let n = 0;
    for (let v = value; v > 0n; v >>= 8n) n++;
    this.uint(n, 4);
    return n ? this.uint(value, n * 8) : this;
  }

  addr(a: { wc: number; hash: Uint8Array }): this {
    this.uint(0b10, 2).bit(0).uint(a.wc & 0xff, 8);
    for (const byte of a.hash) this.uint(byte, 8);
    return this;
  }

  bytes8(data: Uint8Array): this {
    for (const byte of data) this.uint(byte, 8);
    return this;
  }

  get bits(): number {
    return this.len;
  }

  /** Данные ячейки: неполный последний байт помечается единицей — по ней
      читающий узнаёт, где кончаются значащие биты. */
  toCellData(): Uint8Array {
    const out = Uint8Array.from(this.bytes);
    const tail = this.len % 8;
    if (tail) out[out.length - 1]! |= 0x80 >> tail;
    return out;
  }
}

/** Одна ячейка без ссылок, завёрнутая в BOC и base64 — как ждёт кошелёк. */
function bocOf(b: Bits): string {
  const data = b.toCellData();
  const d1 = 0; // ссылок нет, ячейка обычная
  const d2 = Math.ceil(b.bits / 8) + Math.floor(b.bits / 8);
  const cell = [d1, d2, ...data];
  const boc = [
    0xb5, 0xee, 0x9c, 0x72, // магия BOC
    0x01, // без указателя и без контрольной суммы, номер ссылки — один байт
    0x01, // длина смещения — один байт
    0x01, // ячеек: одна
    0x01, // корней: один
    0x00, // отсутствующих: нет
    cell.length, // длина всех ячеек
    0x00, // корень — ячейка номер ноль
    ...cell,
  ];
  let s = "";
  for (const byte of boc) s += String.fromCharCode(byte);
  return btoa(s);
}

/**
 * Тело перевода жетона с текстовой памяткой.
 *
 * `forwardTon` — сколько нанотонов уйдёт вместе с уведомлением получателю:
 * без него памятка до получателя не доедет и перевод будет не опознать.
 */
export function jettonTransfer(opts: {
  units: bigint;
  to: string;
  from: string;
  comment: string;
  forwardTon?: bigint;
}): string {
  const b = new Bits();
  b.uint(0x0f8a7ea5, 32); // transfer по TEP-74
  b.uint(0n, 64); // номер запроса не нужен
  b.coins(opts.units);
  b.addr(parseAddr(opts.to));
  b.addr(parseAddr(opts.from)); // сдача возвращается отправителю
  b.bit(0); // своего вложения нет
  b.coins(opts.forwardTon ?? 1n);
  b.bit(0); // памятка лежит тут же, а не отдельной ячейкой
  b.uint(0, 32); // текстовый комментарий
  b.bytes8(new TextEncoder().encode(opts.comment));
  return bocOf(b);
}
