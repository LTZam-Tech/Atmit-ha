/**
 * Seeded faker per test: the same SEED + same test always produces the same data,
 * so any failure with generated data can be reproduced exactly:
 *     SEED=482913 npx playwright test -g "wrong password"
 */
import { fakerAR, fakerEN, type Faker } from '@faker-js/faker';
import type { TestInfo } from '@playwright/test';
import { environment, type Locale } from '../../config/environment';

export function seededFaker(testInfo: TestInfo, locale: Locale = environment.locale): { faker: Faker; seed: number } {
  const faker = locale === 'ar' ? fakerAR : fakerEN;
  const seed = hash(`${environment.seed}|${testInfo.titlePath.join('>')}|${testInfo.repeatEachIndex}`);
  faker.seed(seed);
  return { faker, seed };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
