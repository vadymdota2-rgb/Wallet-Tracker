/**
 * Порядок сигналов на вкладке — один на список и на карточку.
 *
 * Спот и перпы лежат вместе, а делит их сторона: лонг и шорт. Внутри стороны
 * сортировка по уверенности, а не по площадке: уверенность теперь значит одно
 * и то же на обеих — шанс того, что советует сам сигнал, — и сравнивать их
 * можно напрямую.
 *
 * Функция одна на оба экрана намеренно. Карточка открывается по номеру в
 * списке, и разойдись эти два порядка — человек нажал бы на одну монету, а
 * открылась бы другая.
 */
import type { Signal } from "./types";
import type { CortexSide } from "../store/app";

export function sideOf(s: Signal): CortexSide {
  return s.side === "buy" ? "long" : "short";
}

export function cortexList(list: Signal[], side: CortexSide): Signal[] {
  return list
    .filter((s) => sideOf(s) === side)
    .sort((a, b) => b.conf - a.conf);
}
