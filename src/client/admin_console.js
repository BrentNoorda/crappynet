/*jslint white:false plusplus:false browser:true nomen:false */
/*globals $, alert */
function object_to_string(o)
{
    var html = '{';
    $.each(o, function(k,v) {
        html += '<br/> &nbsp; &nbsp; ' + k + ' : ' + v;
    });
    return html + ' }';
}

function queryServer() {
    var recent_good_transactions = "",
        recent_dropped_requests = "",
        recent_dropped_responses = "",
        recent_unhandled_errors = "";
    $('#updatetime').html(String(new Date()));
    $.getJSON("http://" + location.host + "/?source=stats", /*{ format: "json" },*/ function(stats, textStatus, jqXHR) {
        $.each(stats, function(prop,item) {
            if ($('#' + prop).length !== 0)
            {
                // if element exists on the page, then display it
                if ( item instanceof Array )
                {
                    // show array elements in a nice list
                    var html = '';
                    $.each(item, function(i, v) {
                        var vstr;
                        if (v instanceof Object)
                        {
                            vstr = object_to_string(v);
                        }
                        else
                        {
                            vstr = String(v);
                        }
                        html += '<span style=margin-right:15px>' + (i?'<br/>':'') + '<b>' + (i+1) + '</b>' + '.  ' + vstr + '</span> ';
                    });
                    $('#' + prop).html(html);
                }
                else
                {
                    $('#' + prop).html(item);
                }
            }
        });
    });
}

function hide_settings()
{
    $('#settings').hide('fast');
    $('#no_settings').show();
}

function show_settings()
{
    $('#no_settings').hide();
    $('#settings').show('fast');
}

$(document).ready(function() {
    setInterval(queryServer, 1000);
});
