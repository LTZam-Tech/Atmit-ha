import { Component, computed, input } from '@angular/core';
import { TranslatePipe } from '../core/i18n';

/** Run or result status as a coloured, translated badge (colour is never the only signal: the word is shown). */
@Component({
  selector: 'at-status',
  standalone: true,
  imports: [TranslatePipe],
  template: `<span class="at-badge" [class.ok]="tone() === 'ok'" [class.warn]="tone() === 'warn'" [class.bad]="tone() === 'bad'">{{ status() | t }}</span>`,
})
export class StatusBadge {
  readonly status = input.required<string>();
  protected readonly tone = computed(() => {
    const s = this.status();
    if (s === 'passed') return 'ok';
    if (['failed', 'error', 'timed_out', 'interrupted'].includes(s)) return 'bad';
    if (['queued', 'assigned', 'running', 'flaky', 'healed', 'cancelled'].includes(s)) return 'warn';
    return '';
  });
}
