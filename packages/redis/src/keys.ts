export const keys = {
    event: (eventId: string) => `event:${eventId}`,
    seatHold: (eventId: string, seat: string) => `hold:event:${eventId}:seat:${seat}`,
};
