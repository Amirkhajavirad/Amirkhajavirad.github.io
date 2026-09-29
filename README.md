# Amirkhajavirad.github.io

Personal portfolio. Plain HTML, CSS and two small JavaScript files. No build step and no libraries: the 3D scene is a small hand-written WebGL renderer.

## Files

- `index.html` holds every section. The four layer sections (`#hardware`, `#software`, `#network`, `#data`) each map to one slab of the 3D stack.
- `stage.js` is the WebGL scene: an exploded stack of four layers behind the page. Scroll chooses the layer in focus, the cursor moves the camera and a light, and the stack can be dragged to turn it. Textures are drawn procedurally on a canvas, so there are no 3D asset files.
- `site.js` runs everything else: the depth-parallax portrait, the draggable project collage and its detail dialog, and the over-the-air update simulation.
- `style.css` holds the design tokens (colours and fonts are at the top).
- `images/web/` holds the optimized images. `portrait-plate.webp` and `portrait-cutout.webp` are the two layers of the still About portrait (used when the video is not shown), `amir-intro.mp4` and `amir-intro.webm` are the About video (silent, 10 s, MP4 first with WebM as the fallback), and `amir-intro-first.webp` is its poster, and `stack-poster.webp` is the fallback shown when WebGL is unavailable.
- `files/resume.pdf` is the résumé linked from the site. Replace it when the master résumé changes.
- `about.html`, `projects.html`, `skills.html` and `contact.html` redirect to sections of `index.html` so old links keep working.

## Behaviour worth knowing

- Without WebGL the page shows a still image of the stack and every section stays readable.
- With `prefers-reduced-motion`, the stack is assembled and still, and the portrait does not move.
- Up to 900px wide the stack is pinned in a strip under the header and the text scrolls beneath it.
- The collage is draggable from 760px up. On smaller screens it becomes a list, and every card still opens its detail dialog.

- The About portrait is the video. Its poster (`amir-intro-first.webp`, the first frame) is what shows from the start, so the older still portrait (plate, orange disc and cutout) is never visible when the video can be used. The video loops while on screen and pauses when off screen. It does not load until the section is reached. The still portrait is only the fallback, for reduced motion, data-saver mode or a clip that fails to load. The clip is played as is, so there is a visible jump when it restarts. To replace it, encode a new silent clip as `amir-intro.mp4` and `amir-intro.webm` (about 608x644) and update `amir-intro-first.webp`.

## Editing

- Layer names, and the order of slabs from bottom to top, are in the `LAYERS` array at the top of `stage.js`.
- Project cards are the `.proj` articles in `index.html`. The text inside `.proj__body` is what the dialog shows.
