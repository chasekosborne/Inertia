<img src="public/inertia_banner.svg" alt="Inertia" width="420" />


Inertia is an online 2D physics simulation tool for classical mechanics. Build physical systems, run simulations, and visualize, analyze, and export your results for education and demonstration.

Matter.js under the hood. Vite for the web build. This repo is the source for the hosted site.

### Hosting Inertia locally

```bash
npm install
npm run dev
```

```bash
npm run build    # production to dist/
npm run preview  # serve dist/
```

### Stack

- [Matter.js](https://brm.io/matter-js/) — rigid-body physics
- [Vite](https://vitejs.dev/) — bundler
- [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) — video export
