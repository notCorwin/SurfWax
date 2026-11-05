# Click
## Unacceptable ways to implement this tool
### Chrome DevTools (CDP)
The reasons not to use chrome.debugger are:
- It only accept coordinates.
- There is a race condition between the check and the click.
  - Cursor movement may cause the change of website state.
  - Cannot guarantee web page is stable during the click process.
- The command was successful does not mean it actually worked.
- Need be accessible to debugger.
- Using CDP may be considered as robot.
### element.click
- It cannot simulate the cursor events.
- Not responsible if it is blocked
### dispatchEvent()
- Too flexible, need to splice events manually (LLM-ly)
- Send `pointerdown → mousedown → mouseup → click` by LLM itself
  - And events themselves are not reliable 