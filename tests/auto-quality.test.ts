import { expect, test } from "bun:test";
import { AutoQuality, GOV_FACTORS, MAX_STEP } from "../src/auto-quality";

test("steps down after sustained low fps, one step per window", () => {
  const gov = new AutoQuality();
  expect(gov.update(3.9, 25)).toBe(false);
  expect(gov.step).toBe(0);
  expect(gov.update(0.2, 25)).toBe(true);
  expect(gov.step).toBe(1);
  expect(gov.update(4, 25)).toBe(true);
  expect(gov.step).toBe(2);
});

test("clamps at max step and never below zero", () => {
  const gov = new AutoQuality();
  for (let i = 0; i < 40; i++) gov.update(1, 10);
  expect(gov.step).toBe(MAX_STEP);
  expect(gov.update(1, 10)).toBe(false);
  for (let i = 0; i < 200; i++) gov.update(1, 60);
  expect(gov.step).toBe(0);
  expect(gov.update(1, 60)).toBe(false);
});

test("steps back up only after a long fast stretch", () => {
  const gov = new AutoQuality();
  for (let i = 0; i < 5; i++) gov.update(1, 20);
  expect(gov.step).toBe(1);
  expect(gov.update(19, 60)).toBe(false);
  expect(gov.step).toBe(1);
  expect(gov.update(1.5, 60)).toBe(true);
  expect(gov.step).toBe(0);
});

test("mid-range fps holds the step and resets timers", () => {
  const gov = new AutoQuality();
  gov.update(3, 25);
  gov.update(1, 50); // comfort zone — low timer discarded
  expect(gov.step).toBe(0);
  gov.update(3.9, 25); // needs a fresh full window
  expect(gov.step).toBe(0);
});

test("disabled governor and garbage input never change anything", () => {
  const gov = new AutoQuality();
  gov.enabled = false;
  expect(gov.update(99, 5)).toBe(false);
  expect(gov.step).toBe(0);
  const open = new AutoQuality();
  expect(open.update(0, 30)).toBe(false);
  expect(open.update(-1, 30)).toBe(false);
  expect(open.update(5, NaN)).toBe(false);
  expect(open.update(5, 0)).toBe(false);
  expect(open.step).toBe(0);
});

test("factors shrink render cost; bloom dies last", () => {
  const gov = new AutoQuality();
  expect(gov.factor()).toBe(1);
  expect(gov.bloomOn()).toBe(true);
  expect(GOV_FACTORS[0]).toBe(1);
  for (let i = 1; i < GOV_FACTORS.length; i++) {
    expect(GOV_FACTORS[i]).toBeLessThan(GOV_FACTORS[i - 1]);
  }
  for (let i = 0; i < 30; i++) gov.update(1, 5);
  expect(gov.step).toBe(MAX_STEP);
  expect(gov.factor()).toBeLessThan(1);
  expect(gov.bloomOn()).toBe(false);
  gov.reset();
  expect(gov.step).toBe(0);
  expect(gov.bloomOn()).toBe(true);
});
