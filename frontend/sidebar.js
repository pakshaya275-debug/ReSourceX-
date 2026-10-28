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
        var role = String((user() || {}).role || "").toUpperCase();
        var top = role === "ADMIN"
            ? [["admin_dashboard.html", "home", "Overview"], ["admin_dashboard.html#usersSection", "users", "User Management"], ["admin_dashboard.html#resourcesSection", "package", "All Resources"], ["admin_dashboard.html#requestsSection", "clipboard", "Requests"]]
            : isDonor()
                ? [["donor_dashboard.html", "home", "Dashboard"], ["add_resource.html", "plus", "Add Resource"],
                   ["exchanges.html", "exchange", "Resource Exchange"], ["donor_dashboard.html#requestsSection", "bell", "Requests"],
                   ["donor_dashboard.html#activitySection", "chart", "Activity"]]
                : [["discover.html", "scale", "Smart Match"], ["recipient_dashboard.html#myRequestsSection", "clipboard", "My Requests"],
                   ["exchanges.html", "exchange", "Resource Exchange"]];
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
