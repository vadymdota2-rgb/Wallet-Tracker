/**
 * Переключение языка. Словарь подгружается ДО того, как меняется состояние:
 * иначе экран на кадр показал бы английский, а потом дёрнулся.
 */
import { ensureLang, type LangCode } from "../i18n";
import { useApp } from "../store/app";
import { setLocale } from "./format";

export async function applyLang(code: LangCode, pinned = true): Promise<void> {
  await ensureLang(code);
  setLocale(code);
  useApp.getState().setLang(code, pinned);
}
