import { expect, test, type Browser, type Page } from '@playwright/test'

/** A fresh browser profile signed in as a new one-click guest. */
async function newUser(browser: Browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/login')
  await page.getByRole('button', { name: /guest/i }).click()
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible()
  const name = (await page.locator('.user-menu .avatar').getAttribute('title'))!.replace(' (guest)', '')
  return { context, page, name }
}

async function createDoc(page: Page) {
  await page.getByRole('button', { name: 'New document' }).click()
  await expect(page).toHaveURL(/\/d\/[\w-]+$/)
  await expect(page.locator('.save-indicator')).toContainText('All changes saved')
  return page.url().split('/d/')[1]!
}

/** Create a share link through the real Share dialog and return its URL. */
async function shareLink(page: Page, role: 'Can view' | 'Can comment' | 'Can edit') {
  await page.getByRole('button', { name: 'Share' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Link access').selectOption({ label: role })
  await dialog.getByRole('button', { name: 'Create link' }).click()
  const url = await dialog.getByLabel('Share link').last().inputValue()
  await dialog.getByRole('button', { name: 'Close' }).click()
  return url
}

const editor = (page: Page) => page.getByRole('textbox', { name: 'Document body' })

async function typeAtEnd(page: Page, text: string) {
  await editor(page).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(text, { delay: 15 })
}

test('two people edit together: live text, cursors and presence', async ({ browser }) => {
  const alice = await newUser(browser)
  await createDoc(alice.page)
  await typeAtEnd(alice.page, 'Hello from Alice')
  const link = await shareLink(alice.page, 'Can edit')

  const bob = await newUser(browser)
  await bob.page.goto(link)
  await expect(editor(bob.page)).toContainText('Hello from Alice')

  await typeAtEnd(bob.page, 'And hello from Bob')
  await expect(editor(alice.page)).toContainText('And hello from Bob')

  // Presence avatar + remote caret labelled with the collaborator's (server-verified) name.
  await expect(alice.page.locator('.presence .avatar').first()).toHaveAttribute('title', new RegExp(bob.name))
  await expect(alice.page.locator('.collaboration-carets__label', { hasText: bob.name })).toBeVisible()
  await expect(alice.page.locator('.save-indicator')).toContainText('All changes saved')
})

test('viewers get live updates but cannot edit', async ({ browser }) => {
  const owner = await newUser(browser)
  await createDoc(owner.page)
  const link = await shareLink(owner.page, 'Can view')

  const viewer = await newUser(browser)
  await viewer.page.goto(link)
  await expect(viewer.page.locator('.tb-note')).toHaveText('View only')
  await expect(editor(viewer.page)).toHaveAttribute('contenteditable', 'false')

  await typeAtEnd(owner.page, 'Published update')
  await expect(editor(viewer.page)).toContainText('Published update')
})

test('offline edits on both sides merge when the connection returns', async ({ browser }) => {
  const a = await newUser(browser)
  await createDoc(a.page)
  const link = await shareLink(a.page, 'Can edit')
  const b = await newUser(browser)
  await b.page.goto(link)
  await expect(b.page.locator('.save-indicator')).toContainText('All changes saved')

  await a.page.getByRole('button', { name: 'Go offline' }).click()
  await expect(a.page.locator('.offline-banner')).toBeVisible()
  await typeAtEnd(a.page, 'Typed on a plane')
  await expect(a.page.locator('.save-indicator')).toContainText('edits kept on this device')
  await typeAtEnd(b.page, 'Typed in the office')
  await expect(editor(b.page)).not.toContainText('Typed on a plane')

  await a.page.getByRole('button', { name: 'Reconnect now' }).click()
  for (const p of [a.page, b.page]) {
    await expect(editor(p)).toContainText('Typed on a plane')
    await expect(editor(p)).toContainText('Typed in the office')
  }
  await expect(a.page.locator('.save-indicator')).toContainText('All changes saved')
})

test('comments anchor to text and appear for collaborators in real time', async ({ browser }) => {
  const a = await newUser(browser)
  await createDoc(a.page)
  await typeAtEnd(a.page, 'The quick brown fox jumps')
  const link = await shareLink(a.page, 'Can comment')
  const b = await newUser(browser)
  await b.page.goto(link)
  await b.page.getByRole('button', { name: 'Comments' }).click()

  // Select the last word ("jumps") with the keyboard, then comment on it.
  await editor(a.page).click()
  await a.page.keyboard.press('Control+End')
  await a.page.keyboard.press('Control+Shift+ArrowLeft')
  await a.page.getByRole('button', { name: 'Comment', exact: true }).click()
  await a.page.getByPlaceholder('Add a comment…').fill('Is this the right animal?')
  await a.page.locator('.composer').getByRole('button', { name: 'Comment' }).click()

  await expect(b.page.locator('.thread')).toContainText('Is this the right animal?')
  await expect(b.page.locator('.comment-mark')).toHaveCount(1)
})

test('time travel replays the op log', async ({ browser }) => {
  const a = await newUser(browser)
  await createDoc(a.page)
  await typeAtEnd(a.page, 'First line')
  await expect(a.page.locator('.save-indicator')).toContainText('All changes saved')
  await typeAtEnd(a.page, 'Second line')
  await expect(a.page.locator('.save-indicator')).toContainText('All changes saved')

  await a.page.getByRole('button', { name: 'History' }).click()
  await a.page.getByRole('button', { name: /Replay editing history/ }).click()
  const slider = a.page.getByLabel('Position in history')
  await expect(a.page.locator('.page-preview')).toContainText('Second line')
  await slider.fill('1')
  await expect(a.page.locator('.page-preview')).not.toContainText('Second line')
  await expect(a.page.locator('.replay-pos')).toContainText('Write 1')
})
