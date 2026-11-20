import { Component, input, output } from '@angular/core';
import { TranslatePipe } from './i18n';

/**
 * Shared page states (backlog §2/§3): every list and detail page says the same thing the same way while it loads,
 * when it has nothing to show, and when something went wrong. Texts go through `t` (English and Arabic).
 *   <at-loading />                         <at-loading text="Collecting pages…" />
 *   <at-empty />                           <at-empty text="No rows: the case runs once." />
 *   <at-error [message]="error()" />       <at-error [message]="error()" (retry)="load()" />
 */
@Component({
  selector: 'at-loading',
  standalone: true,
  imports: [TranslatePipe],
  template: `<p class="at-muted at-state-loading" role="status" aria-live="polite"><span class="dot" aria-hidden="true"></span>{{ text() | t }}</p>`,
  styles: [`
    .at-state-loading { display: flex; gap: var(--at-space-2); align-items: center; margin: 0; }
    .dot { inline-size: 10px; block-size: 10px; border-radius: 50%; border: 2px solid currentColor; border-inline-end-color: transparent; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
  `],
})
export class LoadingState {
  readonly text = input('Loading…');
}

@Component({
  selector: 'at-empty',
  standalone: true,
  imports: [TranslatePipe],
  template: `<p class="at-empty" role="status">{{ text() | t }}</p>`,
  styles: [`:host { display: block; } p { margin: 0; }`],
})
export class EmptyState {
  readonly text = input('Nothing here yet.');
}

@Component({
  selector: 'at-error',
  standalone: true,
  imports: [TranslatePipe],
  template: `
    @if (message()) {
      <div class="at-alert at-row" role="alert">
        <span class="at-grow msg">{{ message() }}</span>
        @if (retryable()) { <button type="button" class="at-btn" (click)="retry.emit()">{{ 'Try again' | t }}</button> }
      </div>
    }
  `,
  styles: [`:host { display: block; } :host:empty { display: none; } .msg { white-space: pre-wrap; overflow-wrap: anywhere; }`],
})
export class ErrorState {
  readonly message = input<string | null | undefined>(null);
  /** show "Try again" (the page handles (retry)) */
  readonly retryable = input(false);
  readonly retry = output<void>();
}
