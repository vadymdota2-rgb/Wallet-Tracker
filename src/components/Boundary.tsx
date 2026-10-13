/**
 * Предохранитель для отдельного блока экрана.
 *
 * Ошибка при отрисовке в React роняет всё дерево: из-за одной карточки
 * человек видел бы белый экран вместо приложения. Блок в Boundary при ошибке
 * просто исчезает (или показывает fallback), остальное работает; причина —
 * в консоли.
 */
import { Component, type ReactNode } from "react";

interface Props {
  /** Имя блока — для сообщения в консоли. */
  name: string;
  children: ReactNode;
  fallback?: ReactNode;
}

export class Boundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(`[${this.props.name}]`, error);
  }

  override render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
