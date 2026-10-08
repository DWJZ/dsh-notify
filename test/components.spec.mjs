/**
 * Component checks: custom ids round-trip, questions become clickable controls, and
 * interactions turn into flat answers.
 *
 * Usage: `node test/components.spec.mjs`.
 */
import {
  answeredLine,
  approvalRows,
  makeCustomId,
  modalPayload,
  parseCustomId,
  parseInteraction,
  questionRows,
} from '../components.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label} ${detail}`)
  }
}

console.log('自定义 id 往返')
const id = makeCustomId('A7F3', 'approve')
check('不带细节的 id', id === 'dsh:A7F3:approve', id)
check('解析回来', JSON.stringify(parseCustomId(id)) === JSON.stringify({ code: 'A7F3', kind: 'approve', detail: '' }), JSON.stringify(parseCustomId(id)))
check('带细节的 id', makeCustomId('A7F3', 'choose', '0:2') === 'dsh:A7F3:choose:0:2', makeCustomId('A7F3', 'choose', '0:2'))
check('细节也能解析', parseCustomId('dsh:A7F3:choose:1:3')?.detail === '1:3')
check('别人的 id 不认', parseCustomId('other:A7F3:approve') === null)
check('乱七八糟的输入不炸', parseCustomId(undefined) === null && parseCustomId('') === null)

console.log('\n审批按钮')
const rows = approvalRows('B2C9')
check('一行两个按钮', rows.length === 1 && rows[0].components.length === 2, JSON.stringify(rows))
check('允许是绿色、拒绝是红色', rows[0].components[0].style === 3 && rows[0].components[1].style === 4, JSON.stringify(rows[0].components.map(c => c.style)))
check('按钮文案是中文', rows[0].components.map(c => c.label).join() === '允许一次,拒绝', rows[0].components.map(c => c.label).join())

console.log('\n选择题')
const twoOptions = { id: 'q1', question: '去哪？', options: [{ label: '生产' }, { label: '预发' }] }
const buttons = questionRows('C3D4', twoOptions, 0)
check('少量选项用按钮', buttons[0].components[0].type === 2, String(buttons[0].components[0].type))
check('按钮带位置', buttons[0].components[1].custom_id === 'dsh:C3D4:choose:0:1', buttons[0].components[1].custom_id)

const many = { id: 'q2', question: '选一个', options: Array.from({ length: 8 }, (_, i) => ({ label: `选项${String(i + 1)}` })) }
const select = questionRows('C3D4', many, 1)
check('选项多时用下拉', select[0].components[0].type === 3, String(select[0].components[0].type))
check('下拉项带位置值', select[0].components[0].options[7].value === '1:7', select[0].components[0].options[7].value)
check('选项下面另有一行「自己写」', buttons.length === 2 && buttons[1].components[0].label === '自己写', JSON.stringify(buttons[1]))
check('「自己写」是表单按钮', buttons[1].components[0].custom_id === 'dsh:C3D4:text:0', buttons[1].components[0].custom_id)
check('下拉下面也有「自己写」', select.length === 2 && select[1].components[0].label === '自己写', JSON.stringify(select[1]))

const freeform = questionRows('C3D4', { id: 'q3', question: '随便说点' }, 2)
check('没有选项时给一个"填写答案"按钮', freeform.length === 1 && freeform[0].components[0].label === '填写答案' && freeform[0].components[0].custom_id === 'dsh:C3D4:text:2', JSON.stringify(freeform[0].components[0]))

console.log('\n输入框（Modal）')
const modal = modalPayload('E5F6', { header: '补充说明' }, 0)
check('是 Modal 回调', modal.type === 9, String(modal.type))
check('标题用问题标题', modal.data.title === '补充说明', modal.data.title)
check('输入框是必填的多行文本', modal.data.components[0].components[0].type === 4
  && modal.data.components[0].components[0].required === true, JSON.stringify(modal.data.components[0].components[0]))
check('提交 id 能被认出来', parseCustomId(modal.data.custom_id)?.kind === 'submit', modal.data.custom_id)

console.log('\n解析交互')
const clicked = parseInteraction({
  type: 3,
  data: { custom_id: 'dsh:A7F3:choose:0:1', values: ['0:1'] },
})
check('按钮/下拉点击解析出来', clicked?.code === 'A7F3' && clicked?.kind === 'choose' && clicked?.detail === '0:1', JSON.stringify(clicked))
check('下拉带出所选值', clicked?.values?.[0] === '0:1', JSON.stringify(clicked?.values))

const submitted = parseInteraction({
  type: 5,
  data: {
    custom_id: 'dsh:A7F3:submit:0',
    components: [{ type: 1, components: [{ type: 4, custom_id: 'dsh:A7F3:answer:0', value: '先别发布' }] }],
  },
})
check('表单提交解析出文本', submitted?.kind === 'submit' && submitted?.text === '先别发布', JSON.stringify(submitted))

check('无关交互返回 null', parseInteraction({ type: 2, data: {} }) === null)
check('坏数据不炸', parseInteraction(undefined) === null)

console.log('\n进度行')
check('选项答案渲染成一行', answeredLine(0, { header: '部署目标' }, { id: 'q1', selected: ['预发'] }) === '已答 部署目标：预发', answeredLine(0, { header: '部署目标' }, { id: 'q1', selected: ['预发'] }))
check('自由文本也渲染', answeredLine(1, {}, { id: 'q2', selected: [], custom: '再看' }) === '已答 问题 2：再看', answeredLine(1, {}, { id: 'q2', selected: [], custom: '再看' }))

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
