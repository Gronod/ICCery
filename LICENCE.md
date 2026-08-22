# End-User Licence Agreement (EULA) for ICCery

**IMPORTANT — READ CAREFULLY:** This End-User Licence Agreement ("EULA") is a legal agreement between you (either an individual or a single entity) and the developer of ICCery ("Licensor") for the software product identified above, which includes computer software and may include associated media, printed materials, and "online" or electronic documentation ("Software").

By installing, copying, or otherwise using the Software, you agree to be bound by the terms of this EULA. If you do not agree to the terms of this EULA, do not install or use the Software.

## 1. GRANT OF LICENCE
Licensor grants you a revocable, non-exclusive, non-transferable, limited commercial licence to download, install, and use the ICCery graphical user interface (GUI) software strictly in accordance with the terms of this Agreement. 

## 2. RESTRICTIONS
You agree not to, and you will not permit others to:
* Licence, sell, rent, lease, assign, distribute, transmit, host, outsource, disclose, or otherwise commercially exploit the ICCery GUI.
* Modify, make derivative works of, disassemble, decrypt, reverse compile, or reverse engineer any part of the proprietary ICCery GUI software.
* Remove, alter, or obscure any proprietary notice (including any notice of copyright or trademark) of Licensor or its affiliates, partners, suppliers, or the licensors of the Software.

## 3. INTELLECTUAL PROPERTY
The ICCery GUI (excluding third-party components described below) is proprietary software. All copyrights, patents, trademarks, trade secrets, and other intellectual property rights in the ICCery GUI are and shall remain the sole and exclusive property of the Licensor.

## 4. THIRD-PARTY COMPONENTS & AGPL COMPLIANCE
ICCery relies on and interacts with a modified version of **ArgyllCMS**, an open-source colour management system. 

### Arms-Length Integration
The ICCery software architecture maintains a strict, loosely-coupled separation from ArgyllCMS. The proprietary ICCery GUI operates as a distinct, standalone process that interacts with the ArgyllCMS binaries strictly at arm's length via standard inter-process communication. Specifically, ICCery executes the modified ArgyllCMS binary and receives real-time, line-by-line patch measurement spectral data piped through standard output (stdout). 

Because of this separate process architecture, the proprietary commercial licence of ICCery does not extend to ArgyllCMS, and the AGPLv3 licence of ArgyllCMS does not extend to or infect the proprietary ICCery GUI wrapper.

### ArgyllCMS Licence (AGPLv3)
ArgyllCMS is licensed under the GNU Affero General Public Licence version 3.0 (AGPLv3). 
* The original ArgyllCMS software is copyright (c) Graeme W. Gill.
* In compliance with the AGPLv3, the modifications made to the ArgyllCMS C codebase to implement the custom command-line switch for real-time data output remain fully subject to the AGPLv3.
* **Source Code Availability:** You are entitled to the complete machine-readable source code of the modified ArgyllCMS binaries distributed with this software. The source code for the modified ArgyllCMS component can be obtained at: `https://git.i3omb.com/gronod/argyllcms`.

## 5. DISCLAIMER OF WARRANTY
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## 6. LIMITATION OF LIABILITY
Notwithstanding any damages that you might incur, the entire liability of Licensor and any of its suppliers under any provision of this EULA and your exclusive remedy for all of the foregoing shall be limited to the amount actually paid by you for the Software.

---
*Date of Last Revision: August 2026*