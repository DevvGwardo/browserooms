import { expect, test } from "bun:test";

test("early wall and carpet designs replace surfaces without changing ceiling or world geometry", async () => {
  const current = await Bun.file(new URL("../public/continuous/modules.json", import.meta.url)).json();
  const previous = await Bun.file(new URL("../assets/early-materials/manifest-before.json", import.meta.url)).json();
  expect(current.templates).toEqual(previous.templates);
  expect(current.palette).toEqual(previous.palette);
  for (const [name, material] of Object.entries(current.materials) as [string, any][]) {
    if (material.family === "ceiling" || material.family === "details") {
      expect(material).toEqual(previous.materials[name]);
    } else {
      expect(material.lightmap).toBe(previous.materials[name].lightmap);
      expect(material.normalScale).toBe(1);
      expect(material.roughnessFactor).toBe(1);
      for (const map of ["albedo", "normal", "roughness"]) {
        expect(await Bun.file(new URL(`../public/continuous/${material[map]}`, import.meta.url)).exists()).toBe(true);
      }
      const uvMeters = material.family === "walls" ? 0.5 : 1.2;
      const cycles = current.cellSize / uvMeters * material.uvScale[0];
      expect(cycles).toBeCloseTo(Math.round(cycles), 8);
    }
  }
});
