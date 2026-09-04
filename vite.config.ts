import { defineConfig } from "vite";

// Split the three.js vendor bundle out of the app chunk: renderer upgrades
// (MSAA, DPR, governor) then ship a small app chunk against a cached vendor.
export default defineConfig({
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "vendor-three", test: /node_modules\/three\// }],
        },
      },
    },
  },
});
