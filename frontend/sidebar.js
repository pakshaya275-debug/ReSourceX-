/* ReSourceX shared sidebar for the Profile and Settings pages.
   The top group holds the role's main pages; Settings, My Profile and Logout sit together at the bottom. */
(function () {
    "use strict";
    function user() { try { return JSON.parse(localStorage.getItem("resourceXCurrentUser") || "null"); } catch (e) { return null; } }
    function isDonor() { return String((user() || {}).role || "").toUpperCase() === "DONOR"; }
    function link(href, icon, label, current) {
        var file = href.split("#")[0];
        var active = current === file || current === href;
        return '<a href="' + href + '" class="nav-item' + (active ? " active" : "") + '">' +
            '<span class="ico-slot" data-icon="' + icon + '"></span><span>' + label + "</span></a>";
    }
    window.renderSidebar = function (current) {
        var mount = document.getElementById("sidebarMount");
        if (!mount) return;
        var top = isDonor()
            ? [["donor_dashboard.html", "home", "Dashboard"], ["add_resource.html", "plus", "Add Resource"],
               ["exchanges.html", "exchange", "Resource Exchange"], ["donor_dashboard.html#requests", "bell", "Requests"],
               ["donor_dashboard.html#activity", "chart", "Activity"]]
            : [["discover.html", "scale", "Smart Match"], ["recipient_dashboard.html#myRequestsSection", "clipboard", "My Requests"]];
        var bottom = [["settings.html", "settings", "Settings"], ["profile.html", "user", "My Profile"]];
        mount.innerHTML =
            '<div class="sidebar-logo"><span><span class="ico-slot" data-icon="refresh"></span></span>' +
            '<span class="brand-name">ReSource<span>X</span></span></div>' +
            '<nav class="sidebar-nav">' + top.map(function (t) { return link(t[0], t[1], t[2], current); }).join("") + "</nav>" +
            '<nav class="sidebar-nav sidebar-bottom">' + bottom.map(function (t) { return link(t[0], t[1], t[2], current); }).join("") +
            '<a href="index.html" class="nav-item logout" onclick="localStorage.removeItem(\'resourceXAuthToken\');localStorage.removeItem(\'resourceXCurrentUser\');">' +
            '<span class="ico-slot" data-icon="logout"></span><span>Logout</span></a></nav>';
        if (window.RXIcon) mount.querySelectorAll("[data-icon]").forEach(function (el) { el.innerHTML = RXIcon(el.getAttribute("data-icon")); });
    };
    document.addEventListener("DOMContentLoaded", function () {
        var page = (location.pathname.split("/").pop() || "index.html");
        window.renderSidebar(page);
    });
})();
