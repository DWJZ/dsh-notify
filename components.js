/**
 * Discord message components and interaction payloads.
 *
 * Everything that decides something is pure: a custom id is built and parsed here, a
 * question becomes an action row, and an interaction becomes a compact answer. The
 * plugin owns the pending state; this module never touches the network.
 *
 * Custom ids are `dsh:<code>:<kind>[:<detail>]`, so one reply path can tell a button
 * click, a select choice, and a submitted form apart while still naming the request.
 *
 * @module dsh-notify/components
 */
const PREFIX = 'dsh'

/** Interaction types this plugin answers. */
export const INTERACTION_MESSAGE_COMPONENT = 3
export const INTERACTION_MODAL_SUBMIT = 5

/** Interaction callback types. */
export const CALLBACK_UPDATE_MESSAGE = 7
export const CALLBACK_MODAL = 9

/** Component types. */
const ACTION_ROW = 1
const BUTTON = 2
const STRING_SELECT = 3
const TEXT_INPUT = 4

/** Button styles. */
const STYLE_PRIMARY = 1
const STYLE_SUCCESS = 3
const STYLE_DANGER = 4

/** How many options fit in one select menu, and Discord's own ceilings. */
export const SELECT_LIMIT = 25
export const BUTTON_LIMIT = 5

/**
 * Build the custom id of one control.
 * @param code - the request's correlation code.
 * @param kind - `approve`, `deny`, `choose`, `text`, or `submit`.
 * @param detail - optional index or value the control carries.
 * @returns the custom id.
 */
export function makeCustomId(code, kind, detail = '') {
  return detail === '' ? `${PREFIX}:${code}:${kind}` : `${PREFIX}:${code}:${kind}:${detail}`
}

/**
 * Read one control's custom id.
 * @param value - the raw custom id.
 * @returns the request code, control kind, and detail, or null when it is not ours.
 */
export function parseCustomId(value) {
  if (typeof value !== 'string') return null
  const [prefix, code, kind, ...rest] = value.split(':')
  if (prefix !== PREFIX || !code || !kind) return null
  return { code, kind, detail: rest.join(':') }
}

/**
 * Build the two buttons that decide one approval.
 * @param code - the request's correlation code.
 * @returns one action row.
 */
export function approvalRows(code) {
  return [{
    type: ACTION_ROW,
    components: [
      { type: BUTTON, style: STYLE_SUCCESS, label: '允许一次', custom_id: makeCustomId(code, 'approve') },
      { type: BUTTON, style: STYLE_DANGER, label: '拒绝', custom_id: makeCustomId(code, 'deny') },
    ],
  }]
}

/**
 * Build the controls for one question.
 *
 * Options become a select menu (or buttons when there are at most five), and every
 * question keeps a way to write an answer instead of picking one: a `自己写` button
 * under the options, or the only button when the question has none.
 *
 * @param code - the request's correlation code.
 * @param question - the question being asked.
 * @param index - its position in the request, carried in every custom id.
 * @returns the action rows for the current question.
 */
export function questionRows(code, question, index) {
  const options = Array.isArray(question?.options) ? question.options : []
  const labels = options.map(option => {
    const label = typeof option === 'string' ? option : option?.label
    return typeof label === 'string' && label !== '' ? label : '(未命名选项)'
  })
  const writeIn = {
    type: ACTION_ROW,
    components: [{
      type: BUTTON,
      style: STYLE_PRIMARY,
      label: labels.length > 0 ? '自己写' : '填写答案',
      custom_id: makeCustomId(code, 'text', String(index)),
    }],
  }
  if (labels.length > 0 && labels.length <= BUTTON_LIMIT) {
    return [{
      type: ACTION_ROW,
      components: labels.map((label, position) => ({
        type: BUTTON,
        style: STYLE_PRIMARY,
        label,
        custom_id: makeCustomId(code, 'choose', `${String(index)}:${String(position)}`),
      })),
    }, writeIn]
  }
  if (labels.length > 0) {
    return [{
      type: ACTION_ROW,
      components: [{
        type: STRING_SELECT,
        custom_id: makeCustomId(code, 'choose', String(index)),
        placeholder: '选一个',
        options: labels.slice(0, SELECT_LIMIT).map((label, position) => ({
          label,
          value: `${String(index)}:${String(position)}`,
        })),
      }],
    }, writeIn]
  }
  return [writeIn]
}

/**
 * Build the form that collects a free-text answer.
 * @param code - the request's correlation code.
 * @param question - the question being asked.
 * @param index - its position in the request.
 * @returns the modal payload for a `CALLBACK_MODAL` response.
 */
export function modalPayload(code, question, index) {
  const heading = typeof question?.header === 'string' && question.header !== ''
    ? question.header
    : '你的答案'
  return {
    type: CALLBACK_MODAL,
    data: {
      title: heading.slice(0, 45),
      custom_id: makeCustomId(code, 'submit', String(index)),
      components: [{
        type: ACTION_ROW,
        components: [{
          type: TEXT_INPUT,
          style: 2,
          custom_id: makeCustomId(code, 'answer', String(index)),
          label: '答案',
          required: true,
          max_length: 800,
        }],
      }],
    },
  }
}

/**
 * Turn one gateway interaction into what the plugin needs.
 *
 * @param interaction - the `INTERACTION_CREATE` payload.
 * @returns the request code, control kind, detail, chosen values, and typed text,
 *   or null when the interaction is not a control this plugin posted.
 */
export function parseInteraction(interaction) {
  const type = interaction?.type
  if (type === INTERACTION_MESSAGE_COMPONENT) {
    const parsed = parseCustomId(interaction?.data?.custom_id)
    if (parsed === null) return null
    const values = Array.isArray(interaction?.data?.values) ? interaction.data.values : []
    return { code: parsed.code, kind: parsed.kind, detail: parsed.detail, values, text: undefined }
  }
  if (type === INTERACTION_MODAL_SUBMIT) {
    const parsed = parseCustomId(interaction?.data?.custom_id)
    if (parsed === null) return null
    const rows = Array.isArray(interaction?.data?.components) ? interaction.data.components : []
    const input = rows
      .flatMap(row => (Array.isArray(row?.components) ? row.components : []))
      .find(component => parseCustomId(component?.custom_id)?.kind === 'answer')
    const text = typeof input?.value === 'string' ? input.value : ''
    return { code: parsed.code, kind: 'submit', detail: parsed.detail, values: [], text }
  }
  return null
}

/**
 * Render one answered question as a progress line.
 * @param index - its position in the request.
 * @param question - the question that was answered.
 * @param answer - the answer items the control produced.
 * @returns a single line for the message body.
 */
export function answeredLine(index, question, answer) {
  const heading = typeof question?.header === 'string' && question.header !== ''
    ? question.header
    : `问题 ${String(index + 1)}`
  const chosen = answer.selected.length > 0
    ? answer.selected.join('、')
    : answer.custom ?? ''
  return `已答 ${heading}：${chosen}`
}
