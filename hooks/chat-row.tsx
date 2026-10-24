import type { ClientModule } from 'claude-code'

export type ChatRowProps = {
  conv: string
  title: string
  preview: string
  when: string
  unread: number
  accent: string
}

// One chat in the Desktop list. The whole region takes the click, so the row opens the chat wherever it is pressed.
const ChatRow: ClientModule<ChatRowProps> = (row, surface) => {
  const { Box, Text } = surface.elements
  surface.onPointer(e => {
    if (e.type === 'up' && (e.button ?? 'left') === 'left') surface.post({ open: row.conv })
  })
  const unread = row.unread > 0
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Text weight="semibold" wrap="truncate-end">{row.title}</Text>
        <Text size="caption" dimColor={!unread} color={unread ? row.accent : undefined}>{row.when}</Text>
      </Box>
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Text size="footnote" dimColor={!unread} wrap="truncate-end">{row.preview}</Text>
        {unread && (
          <Box backgroundColor={row.accent} borderStyle="round" borderColor={row.accent} paddingX={1}>
            <Text size="caption" weight="bold" color="#ffffff">{row.unread > 99 ? '99+' : String(row.unread)}</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

export default ChatRow
