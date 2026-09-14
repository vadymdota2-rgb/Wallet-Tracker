/**
 * Копирование в буфер обмена.
 *
 * `navigator.clipboard` в Telegram доступен не всегда — на части сборок его
 * просто нет, на части он молча отказывает вне жеста пользователя. Поэтому
 * при отказе пробуем старый способ через скрытое поле и честно возвращаем
 * неудачу, если не вышло и он: соврать «скопировано» хуже, чем признаться.
 */
export async function copyText(text: string): Promise<boolean> {
  const value = String(text || "");
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Ниже — запасной путь.
  }
  try {
    const el = document.createElement("textarea");
    el.value = value;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
