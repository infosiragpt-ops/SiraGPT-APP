export async function getChatHistory(chatId, prisma) {
    const history = await prisma.message.findMany({
        where: { chatId },
        orderBy: { createdAt: 'asc' }
    });

    return history.map(m => ({
        role: m.role === 'USER' ? 'user' : 'assistant',
        content: m.content
    }));
}
