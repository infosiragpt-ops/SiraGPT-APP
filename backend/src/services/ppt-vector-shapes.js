// backend/src/services/ppt-vector-shapes.js

/**
 * Adds a hexagon pattern to the slide.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {number} x - The x-coordinate for the shape.
 * @param {number} y - The y-coordinate for the shape.
 * @param {object} colors - The color scheme object.
 */
const addHexagonPattern = (slide, x, y, colors) => {
    const hexSize = 0.8;
    const positions = [
        [x, y], [x + 1, y], [x + 2, y],
        [x + 0.5, y + 0.7], [x + 1.5, y + 0.7],
        [x, y + 1.4], [x + 1, y + 1.4], [x + 2, y + 1.4]
    ];

    positions.forEach(([px, py], i) => {
        slide.addShape('hexagon', {
            x: px, y: py, w: hexSize, h: hexSize,
            fill: { color: i % 2 === 0 ? colors.accent : colors.secondary, transparency: 60 },
            line: { color: colors.primary, width: 1.5 }
        });
    });
};

/**
 * Adds a circuit board pattern to the slide.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {number} x - The x-coordinate for the shape.
 * @param {number} y - The y-coordinate for the shape.
 * @param {number} h - The height for the shape.
 * @param {object} colors - The color scheme object.
 */
const addCircuitPattern = (slide, x, y, h, colors) => {
    for (let i = 0; i < 5; i++) {
        slide.addShape('line', {
            x: x + i * 0.7, y: y, w: 0, h: h,
            line: { color: colors.secondary, width: 2.5, dashType: 'dash' }
        });
    }
    for (let i = 0; i < 8; i++) {
        slide.addShape('ellipse', {
            x: x + (i % 4) * 1, y: y + Math.floor(i / 4) * 2,
            w: 0.3, h: 0.3,
            fill: { color: colors.primary }
        });
    }
};

/**
 * Adds a network nodes pattern to the slide.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {number} x - The x-coordinate for the shape.
 * @param {number} y - The y-coordinate for the shape.
 * @param {object} colors - The color scheme object.
 */
const addNetworkPattern = (slide, x, y, colors) => {
    const nodes = [
        [x + 1, y + 0.5], [x + 3, y + 0.5], [x + 5, y + 0.5],
        [x + 2, y + 2], [x + 4, y + 2],
        [x + 1, y + 3.5], [x + 3, y + 3.5], [x + 5, y + 3.5]
    ];

    nodes.forEach((node, i) => {
        if (i < nodes.length - 1) {
            slide.addShape('line', {
                x: node[0], y: node[1],
                w: nodes[i + 1][0] - node[0],
                h: nodes[i + 1][1] - node[1],
                line: { color: colors.accent, width: 1.5, transparency: 40 }
            });
        }
    });

    nodes.forEach(([nx, ny]) => {
        slide.addShape('ellipse', {
            x: nx - 0.2, y: ny - 0.2, w: 0.4, h: 0.4,
            fill: { color: colors.primary },
            line: { color: colors.secondary, width: 1.5 }
        });
    });
};

/**
 * Adds an abstract wave pattern to the slide.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {number} x - The x-coordinate for the shape.
 * @param {number} y - The y-coordinate for the shape.
 * @param {number} w - The width for the shape.
 * @param {object} colors - The color scheme object.
 */
const addWavePattern = (slide, x, y, w, colors) => {
    for (let i = 0; i < 3; i++) {
        slide.addShape('line', {
            x: x, y: y + i * 1.2, w: w, h: 0,
            line: { color: i === 0 ? colors.primary : colors.secondary, width: 8 + i * 4, transparency: 70 - i * 10, cap: 'round' }
        });
    }
};

/**
 * Adds a dynamic swoosh effect to the slide.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {number} x - The x-coordinate for the shape.
 * @param {number} y - The y-coordinate for the shape.
 * @param {number} w - The width for the shape.
 * @param {number} h - The height for the shape.
 * @param {object} colors - The color scheme object.
 */
const addSwooshEffect = (slide, x, y, w, h, colors) => {
    slide.addShape('arc', {
        x: x, y: y, w: w, h: h,
        fill: { color: colors.accent, transparency: 80 },
        angleRange: [180, 360],
        line: { color: colors.primary, width: 3 }
    });
    slide.addShape('arc', {
        x: x + 0.5, y: y + 0.5, w: w - 1, h: h - 1,
        fill: { color: colors.secondary, transparency: 70 },
        angleRange: [190, 350],
    });
};

/**
 * Adds a burst of geometric shapes to the slide.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {number} x - The x-coordinate for the shape.
 * @param {number} y - The y-coordinate for the shape.
 * @param {number} w - The width for the shape.
 * @param {number} h - The height for the shape.
 * @param {object} colors - The color scheme object.
 */
const addGeometricBurst = (slide, x, y, w, h, colors) => {
    const shapes = ['triangle', 'rect', 'ellipse', 'star'];
    for (let i = 0; i < 12; i++) {
        const shape = shapes[i % shapes.length];
        const size = Math.random() * 0.5 + 0.2;
        const angle = (i / 12) * 360;
        const radius = Math.random() * 1.5 + 1;
        const posX = x + w / 2 + radius * Math.cos(angle * Math.PI / 180);
        const posY = y + h / 2 + radius * Math.sin(angle * Math.PI / 180);

        slide.addShape(shape, {
            x: posX, y: posY, w: size, h: size,
            fill: { color: i % 2 === 0 ? colors.primary : colors.secondary, transparency: 50 },
            rotate: Math.random() * 360
        });
    }
};

/**
 * Adds a growth arrow with steps to the slide.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {number} x - The x-coordinate for the shape.
 * @param {number} y - The y-coordinate for the shape.
 * @param {object} colors - The color scheme object.
 */
const addGrowthArrow = (slide, x, y, colors) => {
    const steps = 5;
    for (let i = 0; i < steps; i++) {
        const height = (i + 1) * 0.6;
        slide.addShape('rect', {
            x: x + i * 1, y: y + (3 - height), w: 0.8, h: height,
            fill: { color: colors.secondary, transparency: 40 - i * 5 },
            line: { color: colors.primary, width: 1.5 }
        });
    }
    slide.addShape('rightArrow', {
        x: x + 1.5, y: y - 0.5, w: 2.5, h: 0.8,
        fill: { color: colors.accent },
        line: { color: colors.primary, width: 1.5 }
    });
};

/**
 * Adds a marketing funnel to the slide.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {number} x - The x-coordinate for the shape.
 * @param {number} y - The y-coordinate for the shape.
 * @param {number} w - The width for the shape.
 * @param {number} h - The height for the shape.
 * @param {object} colors - The color scheme object.
 */
const addFunnel = (slide, x, y, w, h, colors) => {
    slide.addShape('trapezoid', {
        x: x, y: y, w: w, h: h * 0.3,
        fill: { color: colors.primary, transparency: 40 },
        line: { color: colors.primary, width: 1.5 },
        flipV: true
    });
    slide.addShape('trapezoid', {
        x: x + 0.5, y: y + h * 0.3, w: w - 1, h: h * 0.35,
        fill: { color: colors.secondary, transparency: 30 },
        line: { color: colors.secondary, width: 1.5 },
        flipV: true
    });
    slide.addShape('trapezoid', {
        x: x + 1, y: y + h * 0.65, w: w - 2, h: h * 0.35,
        fill: { color: colors.accent, transparency: 20 },
        line: { color: colors.accent, width: 1.5 },
        flipV: true
    });
};

/**
 * Adds a data analytics visualization to the slide.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {number} x - The x-coordinate for the shape.
 * @param {number} y - The y-coordinate for the shape.
 * @param {number} w - The width for the shape.
 * @param {object} colors - The color scheme object.
 */
const addAnalyticsVisualization = (slide, x, y, w, colors) => {
    const bars = 6;
    for (let i = 0; i < bars; i++) {
        const barHeight = Math.random() * 2 + 1;
        slide.addShape('rect', {
            x: x + i * 0.8, y: y + (3 - barHeight), w: 0.6, h: barHeight,
            fill: { color: i % 2 === 0 ? colors.primary : colors.secondary, transparency: 30 },
            line: { color: colors.primary, width: 1.5 }
        });
    }
    slide.addShape('line', {
        x: x, y: y + 2.5, w: w - 1, h: -1.5,
        line: { color: colors.accent, width: 2.5 }
    });
};

/**
 * Adds a modern grid pattern to the slide.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {number} x - The x-coordinate for the shape.
 * @param {number} y - The y-coordinate for the shape.
 * @param {object} colors - The color scheme object.
 */
const addGridPattern = (slide, x, y, colors) => {
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            const opacity = (i + j) % 3 === 0 ? 50 : 30;
            slide.addShape('rect', {
                x: x + i * 1.2, y: y + j * 1, w: 1, h: 0.8,
                fill: { color: colors.accent, transparency: opacity },
                line: { color: colors.primary, width: 1 }
            });
        }
    }
};

const vectorShapes = {
    hexagon: addHexagonPattern,
    circuit: addCircuitPattern,
    network: addNetworkPattern,
    wave: addWavePattern,
    swoosh: addSwooshEffect,
    geometricBurst: addGeometricBurst,
    growth: addGrowthArrow,
    funnel: addFunnel,
    analytics: addAnalyticsVisualization,
    grid: addGridPattern,
};

module.exports = vectorShapes;
