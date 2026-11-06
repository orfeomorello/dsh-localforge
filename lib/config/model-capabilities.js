/** True when the model can receive image content. */
export function modelSupportsVision(override, discovered) {
    return (override?.vision ?? discovered?.vision) !== false;
}
