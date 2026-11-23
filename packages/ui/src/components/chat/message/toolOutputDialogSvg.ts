export const getSvgAspectRatio = (svg: SVGElement): number | null => {
    try {
        const groups = Array.from(svg.querySelectorAll('g'));
        let bestArea = 0;
        let bestRatio: number | null = null;

        for (const group of groups) {
            if (!(group instanceof SVGGraphicsElement)) {
                continue;
            }
            const box = group.getBBox();
            if (!(box.width > 0 && box.height > 0)) {
                continue;
            }
            const area = box.width * box.height;
            if (area > bestArea) {
                bestArea = area;
                bestRatio = box.width / box.height;
            }
        }

        if (bestRatio && Number.isFinite(bestRatio) && bestRatio > 0) {
            return bestRatio;
        }
    } catch {
    }

    const viewBox = svg.getAttribute('data-oc-mermaid-original-viewbox') ?? svg.getAttribute('viewBox');
    if (viewBox) {
        const parts = viewBox.trim().split(/\s+/).map(Number);
        if (parts.length === 4) {
            const width = parts[2];
            const height = parts[3];
            if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
                return width / height;
            }
        }
    }

    const attrWidth = Number(svg.getAttribute('width'));
    const attrHeight = Number(svg.getAttribute('height'));
    if (Number.isFinite(attrWidth) && Number.isFinite(attrHeight) && attrWidth > 0 && attrHeight > 0) {
        return attrWidth / attrHeight;
    }

    const rect = svg.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        return rect.width / rect.height;
    }

    return null;
};
