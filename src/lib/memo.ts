/**
 * Память ответов на время жизни приложения.
 *
 * Всё, что экраны раньше подгружали только по нажатию, — позиции кошельков,
 * крупные сделки за окна, фильтры потока, графики сигналов, сделки трейдеров —
 * при запуске подтягивается заранее (см. prefetch.ts) и лежит здесь. Экран
 * берёт готовое сразу, без скелета, а сам запрос уходит, только если ответ
 * устарел.
 *
 * Одинаковые запросы не дублируются: пока первый в пути, второй ждёт его же.
 * Отмена экрана запрос не рвёт — ответ всё равно пригодится следующему.
 */
type Hit = { at: number; v: unknown };

const MAX = 400;
const store = new Map<string, Hit>();
const wait = new Map<string, Promise<unknown>>();

/** Свежий ответ из памяти или undefined. */
export function peek<T>(key: string, ttl: number): T | undefined {
  const hit = store.get(key);
  if (!hit || Date.now() - hit.at > ttl) return undefined;
  return hit.v as T;
}

/**
 * Ответ из памяти, а если его нет или он устарел — загрузка. Запоминается
 * только годный ответ (`keep`): сбой сети не должен залипать на экране до
 * конца срока.
 */
export function remember<T>(
  key: string,
  ttl: number,
  load: () => Promise<T>,
  keep: (v: T) => boolean,
): Promise<T> {
  const hit = peek<T>(key, ttl);
  if (hit !== undefined) return Promise.resolve(hit);
  const busy = wait.get(key);
  if (busy) return busy as Promise<T>;
  const p = load()
    .then((v) => {
      if (keep(v)) {
        store.delete(key);
        store.set(key, { at: Date.now(), v });
        while (store.size > MAX) store.delete(store.keys().next().value as string);
      }
      return v;
    })
    .finally(() => wait.delete(key));
  wait.set(key, p);
  return p;
}

/** Последний годный ответ любой свежести — показать сразу, пока идёт новый. */
export function peekAny<T>(key: string): T | undefined {
  return store.get(key)?.v as T | undefined;
}

/** Забыть один ответ — следующий запрос пойдёт на сервер. */
export function forget(key: string): void {
  store.delete(key);
}

/** Забыть всё: сменился план или человек, и прежние ответы уже не про него. */
export function forgetAll(): void {
  store.clear();
}
