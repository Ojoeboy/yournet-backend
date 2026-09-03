// RouterOS .rsc starting-config builder - extracted out of routes/sites.js
// so the owner wizard (public/rsc-wizard.html -> POST /api/sites/:id/rsc-config)
// and the installer wizard (public/installer.html ->
// POST /api/installers/me/sites/:id/rsc-config) call the exact same code
// path instead of two copies that could silently drift apart over time.
//
// Pure function: takes the site row and its tenant's active packages plus
// the network-shape answers from whichever wizard called it, and returns
// the finished .rsc text. No DB access, no req/res - callers own fetching
// the site/packages and sending the response.
//
// See the original header comment (now here) for the full picture of what
// this does and its honest limits:
//
//   - WAN type: DHCP / static IP / PPPoE (fiber, DSL, some 4G setups)
//   - Wired AP ports: any number of ethernet ports, not a fixed ether2-5
//   - Wireless backhaul links: for APs too far to run a cable to, this
//     generates a backhaul link per remote AP - the main router broadcasts
//     a private backhaul SSID, and the remote AP must be separately
//     configured (once, on that device) to connect to it as a station. That
//     remote-side setup can't be pushed from here.
//
// HONEST LIMITS, stated plainly rather than glossed over:
//   - Wireless config comes in two syntaxes, chosen via wirelessSyntax:
//       'legacy' - the `/interface wireless` menu, for RouterOS 6 and most
//                  RouterOS 7 devices on older (pre-Wi-Fi 6) wireless chips.
//                  Uses a WDS station-bridge link per remote AP.
//       'wifi6'  - RouterOS 7's newer unified `/interface wifi` package
//                  (Wi-Fi 6/6E chips, e.g. the wifi-qcom driver). Uses
//                  native AP/station-bridge mode instead of WDS. The
//                  property names here (configuration.mode, security.*,
//                  datapath.bridge) are confirmed against MikroTik's own
//                  documentation, not guessed - but this codebase hasn't
//                  run it against real Wi-Fi 6/6E hardware, so treat it as
//                  a strong starting point to review, not a proven
//                  drop-in. If a router only has one built-in radio, only
//                  the first backhaul link can use it directly - more
//                  simultaneous links need a second radio or a virtual AP
//                  interface, which this generator doesn't create.
//     Picking the wrong one for your hardware needs adapting, not
//     copy-paste - if you're not sure which package your router runs,
//     check Winbox/WebFig under Interfaces for a "WiFi" vs "Wireless" menu.
//   - This assumes the ROUTER ITSELF has a wireless radio capable of
//     AP-bridge/station mode. A radio-less model (like a hEX S) cannot do
//     the wireless-backhaul part at all - only the wired-port section
//     applies.
function buildMikrotikRsc(site, packages, options) {
  const {
    wanType = 'dhcp',            // 'dhcp' | 'static' | 'pppoe'
    wanInterface = 'ether1',
    staticAddress, staticGateway, // used when wanType === 'static'
    pppoeUsername, pppoePassword, // used when wanType === 'pppoe'
    wiredPorts = [2, 3, 4, 5],    // ether port numbers for the wired AP bridge
    routerHasWifi = false,
    wirelessSyntax = 'legacy',    // 'legacy' (/interface wireless) | 'wifi6' (/interface wifi, Wi-Fi 6/6E)
    wirelessLinks = [],           // [{ name, ssid, password }] - one per remote wireless AP
  } = options || {};

  if (!['legacy', 'wifi6'].includes(wirelessSyntax)) {
    throw Object.assign(new Error("wirelessSyntax must be 'legacy' or 'wifi6'"), { status: 400 });
  }

  const slug = site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'yournet';
  const hotspotProfile = site.mk_hotspot_profile || 'default';
  const bridgeName = `bridge-${slug}`;

  const profileLines = packages.map((p) => {
    const rate = p.rate_limit_up && p.rate_limit_down ? `${p.rate_limit_up}/${p.rate_limit_down}` : '';
    return `/ip hotspot user profile add name="${slug}-${p.label.toLowerCase().replace(/\s+/g, '-')}"` +
      (rate ? ` rate-limit="${rate}"` : '') +
      ` session-timeout=${p.duration_minutes}m`;
  });

  // --- WAN section, branches by type ---
  let wanSection;
  if (wanType === 'static') {
    wanSection = `# Static WAN IP
/ip address add address=${staticAddress || '<FILL-IN-YOUR-STATIC-IP>/24'} interface=${wanInterface}
/ip route add gateway=${staticGateway || '<FILL-IN-YOUR-GATEWAY>'}`;
  } else if (wanType === 'pppoe') {
    wanSection = `# PPPoE WAN (fiber/DSL-style connections)
/interface pppoe-client add interface=${wanInterface} user="${pppoeUsername || '<FILL-IN-PPPOE-USERNAME>'}" password="${pppoePassword || '<FILL-IN-PPPOE-PASSWORD>'}" name=pppoe-out1 add-default-route=yes disabled=no`;
  } else {
    wanSection = `# DHCP client WAN (typical for Starlink-style Ethernet-in setups)
/ip dhcp-client add interface=${wanInterface} disabled=no`;
  }
  const natOutInterface = wanType === 'pppoe' ? 'pppoe-out1' : wanInterface;

  // --- Wired AP bridge ports ---
  const wiredPortLines = wiredPorts.map((n) => `/interface bridge port add bridge=${bridgeName} interface=ether${n}`);

  // --- Wireless backhaul links to remote APs (only if this router has its own radio) ---
  let wirelessSection = '';
  if (routerHasWifi && wirelessLinks.length) {
    if (wirelessSyntax === 'wifi6') {
      wirelessSection = `\n# Wireless backhaul links - one WiFi 6/6E AP-mode radio per remote AP,
# native-bridged into ${bridgeName} via datapath.bridge (no WDS needed on
# this newer driver). IMPORTANT: each remote AP must ALSO be configured
# (once, on that device) as a station-bridge connecting to the matching
# SSID below - this file only configures THIS router's side of each link.
# Only the first link can use a router with a single built-in radio - see
# the comment above this function for what additional links need.
${wirelessLinks.map((link, i) => {
  const ifaceName = `wifi${i + 1}`;
  const secName = `wifi-link${i + 1}-sec`;
  return `/interface wifi security add name=${secName} authentication-types=wpa2-psk,wpa3-psk passphrase="${link.password || '<SET-A-STRONG-PASSWORD>'}"
/interface wifi set [ find default-name=${ifaceName} ] configuration.mode=ap configuration.ssid="${link.ssid || `${slug}-link${i + 1}`}" security=${secName} datapath.bridge=${bridgeName} disabled=no comment="Backhaul to: ${link.name || 'remote AP ' + (i + 1)}"`;
}).join('\n')}`;
    } else {
      wirelessSection = `\n# Wireless backhaul links - one WDS station-bridge per remote AP.
# IMPORTANT: each remote AP must ALSO be configured (once, on that device)
# as a WDS station connecting to the matching SSID below - this file only
# configures THIS router's side of each link.
${wirelessLinks.map((link, i) => {
  const ifaceName = `wlan-link${i + 1}`;
  return `/interface wireless add name=${ifaceName} mode=ap-bridge ssid="${link.ssid || `${slug}-link${i + 1}`}" wds-mode=dynamic wds-default-bridge=${bridgeName} disabled=no comment="Backhaul to: ${link.name || 'remote AP ' + (i + 1)}"
/interface wireless security-profiles add name=${ifaceName}-sec mode=dynamic-keys authentication-types=wpa2-psk wpa2-pre-shared-key="${link.password || '<SET-A-STRONG-PASSWORD>'}"
/interface wireless set ${ifaceName} security-profile=${ifaceName}-sec`;
}).join('\n')}`;
    }
  }

  const rsc = `# YourNet Control - RouterOS starting config for site: ${site.name}
# Generated from your actual packages and network shape - REVIEW before importing.
# See comments above the wireless section (if present) for real limitations.

${wanSection}

/interface bridge add name=${bridgeName}
${wiredPortLines.join('\n') || '# No wired AP ports specified'}
${wirelessSection}

/ip pool add name=${slug}-pool ranges=10.5.0.10-10.5.0.254
/ip address add address=10.5.0.1/24 interface=${bridgeName}

/ip firewall nat add chain=srcnat out-interface=${natOutInterface} action=masquerade comment="${site.name} internet uplink"

/ip hotspot profile add name="${hotspotProfile}" hotspot-address=10.5.0.1 login-by=http-chap

/ip hotspot add name="${slug}-hotspot" interface=${bridgeName} address-pool=${slug}-pool profile="${hotspotProfile}"

# One profile per package, with the actual limits set in your app:
${profileLines.join('\n') || '# No active packages yet - create some in /admin first.'}
`;

  return { slug, rsc };
}

module.exports = { buildMikrotikRsc };
