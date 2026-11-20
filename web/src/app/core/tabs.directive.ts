import { Directive, ElementRef, HostListener, inject } from '@angular/core';

/**
 * Keyboard for every tab bar (WAI-ARIA tabs pattern): ←/→ move to the previous/next tab, Home/End to the first/last,
 * and the tab is activated as it receives focus. In right-to-left pages the arrows follow the reading direction.
 */
@Directive({ selector: '[role="tablist"]', standalone: true })
export class TabsKeyboard {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  @HostListener('keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    const tabs = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[role="tab"]'));
    const i = tabs.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const rtl = getComputedStyle(this.host.nativeElement).direction === 'rtl';
    const next = { ArrowRight: rtl ? i - 1 : i + 1, ArrowLeft: rtl ? i + 1 : i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    target.focus();
    target.click();
  }
}
