# LiDAR-X Frontend

React, Three.js, and Canvas views for recorded and uploaded LiDAR scans.

```bash
npm ci
npm run dev
```

Start the backend from the repository root:

```bash
python3 -m uvicorn backend.app:app --port 8000
```

Vite proxies `/api` to the backend. `npm run build` produces `dist`, which the
backend serves at http://localhost:8000. See the root README for model installation,
input formats, exports, and deployment.

## Deployment env

Set these for static hosting such as Vercel:

```bash
VITE_FRAME_MANIFEST_URL=https://huggingface.co/datasets/ranbyDipz/sih-lidar-clip/resolve/main/manifest.json
VITE_API_BASE_URL=https://YOUR-BACKEND.example.com/api
```

`VITE_API_BASE_URL` is optional. If it is omitted, the recorded dataset still works
and the upload flow is disabled in the UI.
