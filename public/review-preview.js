const rendered = new WeakMap();

function boxFor(viewport, rectangle) {
  const [x1, y1] = viewport.convertToViewportPoint(rectangle[0], rectangle[1]);
  const [x2, y2] = viewport.convertToViewportPoint(rectangle[2], rectangle[3]);
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

export async function reviewCrop(pdfjs, input, pageNumber, regions) {
  const loading = pdfjs.getDocument({ ...input, isEvalSupported: false, enableXfa: false });
  try {
    const pdf = await loading.promise;
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const boxes = regions.map((rect) => boxFor(base, rect));
    const left = Math.max(0, Math.min(...boxes.map((box) => box[0])) - 18);
    const top = Math.max(0, Math.min(...boxes.map((box) => box[1])) - 18);
    const width = Math.max(24, Math.min(base.width, Math.max(...boxes.map((box) => box[2])) + 18) - left);
    const height = Math.max(24, Math.min(base.height, Math.max(...boxes.map((box) => box[3])) + 18) - top);
    const scale = Math.min(2, 680 / width, 440 / height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    await page.render({
      canvasContext: canvas.getContext("2d", { alpha: false }),
      viewport: page.getViewport({ scale }),
      transform: [1, 0, 0, 1, -left * scale, -top * scale]
    }).promise;
    const image = document.createElement("img");
    image.alt = "审阅 PDF 第 " + pageNumber + " 页批注截图";
    image.src = canvas.toDataURL("image/png");
    return image;
  } finally {
    await loading.destroy();
  }
}

export function selectedPdfReview(root, version) {
  const selection = document.getSelection();
  const quote = selection?.toString().trim();
  if (!quote || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const shellFor = (node) => (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest(".pdf-page-shell");
  const shell = shellFor(range.startContainer);
  if (!shell || !root.contains(shell) || shell !== shellFor(range.endContainer) || !shell.reviewPage) return null;
  const { page, viewport } = shell.reviewPage;
  const bounds = shell.getBoundingClientRect();
  const scaleX = viewport.width / bounds.width;
  const scaleY = viewport.height / bounds.height;
  const regions = [...range.getClientRects()]
    .filter((rect) => rect.width > 1 && rect.height > 1 && rect.left >= bounds.left - 2 && rect.right <= bounds.right + 2)
    .slice(0, 100).map((rect) => {
      const [left, top] = viewport.convertToPdfPoint((rect.left - bounds.left) * scaleX, (rect.top - bounds.top) * scaleY);
      const [right, bottom] = viewport.convertToPdfPoint((rect.right - bounds.left) * scaleX, (rect.bottom - bounds.top) * scaleY);
      return [Math.min(left, right), Math.min(top, bottom), Math.max(left, right), Math.max(top, bottom)];
    });
  if (!regions.length) return null;
  const number = Number(shell.dataset.page);
  const [x1, y1, x2, y2] = regions[0];
  return {
    quote: quote.slice(0, 1000),
    pdf: {
      page: number, regions, version,
      point: { page: number, x: Math.max(0, (x1 + x2) / 2 - page.view[0]), y: Math.max(0, page.view[3] - (y1 + y2) / 2) }
    }
  };
}

function projectionRegion(location, view) {
  const x = view[0] + location.x;
  const y = view[3] - location.y;
  return [x, y - location.height, x + location.width, y];
}

function addMarker(shell, item, regions, choose, selected) {
  let layer = shell.querySelector(".review-pdf-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "review-pdf-layer";
    shell.append(layer);
  }
  const { viewport } = shell.reviewPage;
  for (const [index, region] of regions.entries()) {
    const [x1, y1, x2, y2] = boxFor(viewport, region);
    const shape = document.createElement("div");
    shape.className = "review-pdf-shape";
    shape.classList.toggle("active", item.id === selected);
    shape.classList.toggle("handled", item.status === "resolved" || item.status === "rejected");
    const percent = (number, size) => (100 * number / size).toFixed(3) + "%";
    shape.style.left = percent(Math.min(viewport.width - 2, Math.max(0, x1)), viewport.width);
    shape.style.top = percent(Math.min(viewport.height - 2, Math.max(0, y1)), viewport.height);
    shape.style.width = percent(Math.max(4, Math.min(viewport.width, x2) - Math.max(0, x1)), viewport.width);
    shape.style.height = percent(Math.max(4, Math.min(viewport.height, y2) - Math.max(0, y1)), viewport.height);
    if (index === 0) {
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "review-pdf-badge";
      badge.dataset.reviewId = item.id;
      badge.title = item.displayAuthor + " · " + (item.text || item.quote || "批注").slice(0, 110);
      badge.setAttribute("aria-label", badge.title);
      badge.textContent = String(1 + item.replies.length);
      badge.addEventListener("pointerdown", (event) => event.stopPropagation());
      badge.addEventListener("click", (event) => { event.stopPropagation(); choose(item.id, { jump: true }); });
      shape.append(badge);
    }
    layer.append(shape);
  }
}

export async function renderReviewMarks(root, items, { revision, forward, selected, choose }) {
  let state = rendered.get(root);
  if (!state || state.revision !== revision) {
    state = { revision, counter: 0, cache: new Map() };
    rendered.set(root, state);
  }
  const generation = ++state.counter;
  const shells = new Map([...root.querySelectorAll(".pdf-page-shell")].filter((shell) => shell.reviewPage).map((shell) => {
    shell.querySelector(".review-pdf-layer")?.remove();
    return [Number(shell.dataset.page), shell];
  }));
  if (!revision || !shells.size) return;
  const pending = [];
  for (const item of items) {
    if (item.pdf?.version === revision && item.pdf.regions?.length && shells.has(item.pdf.page)) {
      addMarker(shells.get(item.pdf.page), item, item.pdf.regions, choose, selected);
    } else if (item.anchor) pending.push(item);
  }
  for (let i = 0; i < pending.length; i += 4) {
    if (rendered.get(root) !== state || state.counter !== generation) return;
    await Promise.all(pending.slice(i, i + 4).map(async (item) => {
      const { file, line } = item.anchor;
      const key = file + ":" + line;
      if (!state.cache.has(key)) state.cache.set(key, forward(file, line).catch(() => null));
      const location = await state.cache.get(key);
      if (state.counter !== generation || rendered.get(root) !== state || !location) return;
      const shell = shells.get(location.page);
      if (shell?.isConnected) addMarker(shell, item, [projectionRegion(location, shell.reviewPage.page.view)], choose, selected);
    }));
  }
}
