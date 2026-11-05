export const truncateText = (text: string): string => {
    return text.length > 11 ? text.slice(0, 9) + '...' : text;
};